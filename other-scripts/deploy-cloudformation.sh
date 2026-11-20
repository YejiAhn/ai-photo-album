#!/usr/bin/env bash
set -euo pipefail

# Run from any directory. This file must stay in the repository's other-scripts/.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

REGION="us-east-1"
STACK_NAME="${1:-photo-album-cf}"
EXPECTED_ACCOUNT="668506405900"
export AWS_PAGER=""

if [[ ! "$STACK_NAME" =~ ^[a-z][a-z0-9-]{0,19}$ ]]; then
  echo 'Use a lowercase stack name of 1-20 characters, such as photo-album-cf.' >&2
  exit 1
fi

command -v aws >/dev/null
command -v python3 >/dev/null

# Fail before creating resources if the repository is incomplete or Lambda
# code still hard-codes the production index/bucket.
python3 - <<'PY'
import ast
from pathlib import Path

for name in ('index-photos', 'search-photos'):
    path = Path('lambda-functions') / name / 'lambda_function.py'
    source = path.read_text()
    tree = ast.parse(source, filename=str(path))
    compile(tree, str(path), 'exec')
    env_gets = {
        node.args[0].value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == 'get'
        and isinstance(node.func.value, ast.Attribute)
        and isinstance(node.func.value.value, ast.Name)
        and node.func.value.value.id == 'os'
        and node.func.value.attr == 'environ'
        and node.args and isinstance(node.args[0], ast.Constant)
    }
    required = {'OPENSEARCH_INDEX'} | ({'PHOTO_BUCKET'} if name == 'search-photos' else set())
    if not required <= env_gets:
        raise SystemExit(f'{path}: add os.environ.get for {sorted(required - env_gets)}. See CLOUDFORMATION.md.')
for name in ('index.html', 'app.js', 'sdk-binary.js', 'sdk/apigClient.js'):
    path = Path('front-end') / name
    if not path.is_file():
        raise SystemExit(f'Missing frontend file: {path}')
print('Repository preflight passed.')
PY

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT" ]]; then
  echo "Wrong AWS account: $ACCOUNT_ID. Expected $EXPECTED_ACCOUNT." >&2
  exit 1
fi

ARTIFACT_BUCKET="${STACK_NAME}-artifacts-${ACCOUNT_ID}-${REGION}"
if ! aws s3api head-bucket --region "$REGION" --bucket "$ARTIFACT_BUCKET" >/dev/null 2>&1; then
  aws s3api create-bucket --region "$REGION" --bucket "$ARTIFACT_BUCKET" >/dev/null
fi
aws s3api put-public-access-block --region "$REGION" --bucket "$ARTIFACT_BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --region "$REGION" --bucket "$ARTIFACT_BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

mkdir -p .cfn-build
aws cloudformation package \
  --region "$REGION" \
  --template-file other-scripts/template.yaml \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --s3-prefix lambda-code \
  --output-template-file .cfn-build/packaged.yaml

# API Gateway Deployment is a snapshot. Replace its logical ID when the source
# template changes, so an updated method configuration reaches the dev stage.
python3 - <<'PY'
import hashlib
from pathlib import Path
digest = hashlib.sha256(Path('other-scripts/template.yaml').read_bytes()).hexdigest()[:12]
path = Path('.cfn-build/packaged.yaml')
path.write_text(path.read_text().replace('ApiDeploymentV1', 'ApiDeployment' + digest))
PY

aws cloudformation validate-template --region "$REGION" \
  --template-body file://.cfn-build/packaged.yaml >/dev/null

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file .cfn-build/packaged.yaml \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --no-fail-on-empty-changeset

aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output table

# The template provisions the website bucket; this step publishes actual UI
# files and points a temporary copy of the generated SDK at the NEW API.
python3 other-scripts/publish-cf-frontend.py "$STACK_NAME"

echo 'Done. Review the stack Events, Resources and Outputs in CloudFormation.'
