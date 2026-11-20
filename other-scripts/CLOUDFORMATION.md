# Assignment 3 — CloudFormation copies

This package adds deployment files to your existing `ai-photo-album` repository.
It does not contain or replace your actual Lambda or frontend source code.

## 1. Copy these files

Copy this package's four files into your repository's existing `other-scripts/`.
Keep the existing `buildspec-lambda.yml` and `buildspec-frontend.yml`.

Required repository layout:

```
front-end/
  index.html
  app.js
  style.css
  config.js
  sdk-binary.js
  sdk/apigClient.js
  sdk/lib/...
lambda-functions/
  index-photos/lambda_function.py
  search-photos/lambda_function.py
other-scripts/
  buildspec-lambda.yml
  buildspec-frontend.yml
  template.yaml
  deploy-cloudformation.sh
  publish-cf-frontend.py
  CLOUDFORMATION.md
```

In BOTH Lambda source files, replace the constant index setting with:

```python
INDEX_NAME = os.environ.get("OPENSEARCH_INDEX", "photos")
```

In the search Lambda, replace the constant bucket setting with:

```python
PHOTO_BUCKET = os.environ.get(
    "PHOTO_BUCKET", "yeji-ai-photo-album-photos-2026"
)
```

The existing functions keep using their defaults. Copies receive different
values through CloudFormation environment variables. Do not set AWS_REGION as
a custom Lambda environment variable; AWS supplies it.

Add these lines to your repository's `.gitignore` (create it if needed):

```
.cfn-build/
__pycache__/
*.pyc
```

Commit and push the source changes and these deployment files to `main`.
Your two existing pipelines will run as usual.

## 2. Bring the complete repository to AWS CloudShell

In GitHub choose **Code → Download ZIP**. This works for a private repository
when you are signed in. Download the current ZIP after your commit is pushed.

Open CloudShell in **us-east-1**, then choose **Actions → Upload file** and
upload the repository ZIP (not just this small CloudFormation package).

In a fresh CloudShell folder:

```bash
unzip ai-photo-album-main.zip
cd ai-photo-album-main
bash other-scripts/deploy-cloudformation.sh
```

If your ZIP has a different filename, substitute that exact filename.
The script expects AWS account `668506405900` and defaults to stack
`photo-album-cf`. It requires permissions to create the listed resources and
pass the new IAM roles. CloudShell uses the console account's credentials.
Do not paste an AWS access key into these files.

## 3. What deployment does

1. Checks both Lambda files and frontend files before creating AWS resources.
2. Creates/reuses a private artifact bucket named
   `photo-album-cf-artifacts-668506405900-us-east-1` for Lambda ZIPs.
   This bootstrap bucket is outside the application stack.
3. Runs `aws cloudformation package`, packaging the repository's CURRENT Lambda
   folders into S3. Local `CodeUri` paths are relative to `template.yaml`.
4. Validates the packaged template and deploys the application stack.
5. Publishes a temporary frontend copy to the NEW website bucket. It changes
   only that copy's generated SDK URL and browser demo API key so it uses the
   NEW API. Original repository files and production buckets are untouched.

The stack provisions:

| Resource | Behavior |
| --- | --- |
| Two Python 3.13 x86_64 Lambdas | Uses actual repository source, existing dependency Layer version 1 |
| Private photos S3 | New uploads trigger the new indexing Lambda |
| Public frontend S3 | Static website, public GET only |
| REST API Gateway | GET /search, PUT /photos direct S3 proxy, OPTIONS/CORS, binary uploads |
| API key and usage plan | Key required on GET/PUT, 2 requests/s, burst 5, 1000/day |
| IAM roles/permissions | Separate roles for indexing, searching and API S3 uploads |
| CloudWatch log groups | Seven-day retention for copied functions |

Reused external dependencies: existing Lex bot, existing OpenSearch domain,
and existing Layer. The stack does NOT create another OpenSearch domain or
another pair of CodePipelines. This is a copy-provisioning demonstration;
your original site remains the primary assignment demo.

The copies use index `photos-cf-demo`, separate from production index `photos`.
Upload a NEW photo through the copied frontend before trying to find it there.
The index is created by the first valid photo event, not by CloudFormation.
Deploy additional stacks with different OpenSearchIndex parameter values if
you need simultaneous isolated copies; the default is for one demo stack.

## 4. Verify and record

Open **CloudFormation → Stacks → photo-album-cf** in us-east-1.

- Stack status should be `CREATE_COMPLETE` (or `UPDATE_COMPLETE` on a rerun).
- In **Resources**, show the two Lambdas, both S3 buckets, REST API and roles.
- In **Outputs**, show `FrontendWebsiteURL` and the resource names.
- Open `FrontendWebsiteURL` after the script finishes publishing files.
- Upload a small JPG/PNG with a custom label, allow indexing to finish, then search.
- The website endpoint is HTTP because it is S3 static website hosting.
- A stale API key saved through Settings can override config.js in that tab.
  Use a fresh tab for this copied site if needed. The copied API has a new key.

CloudFormation CREATE_COMPLETE verifies infrastructure provisioning. It does
not itself verify that Lex, OpenSearch or the frontend's upload/search works.
Do the smoke test separately if you plan to demonstrate the copy's behavior.
Only record a stack as successful after observing its actual status.

## 5. Update and cleanup

After changing Lambda code, rerun the script from the updated repository.
Packaging creates a new S3 code location when content changes, so CloudFormation
updates the copied functions. After changing frontend code, rerun the script or:

```bash
python3 other-scripts/publish-cf-frontend.py photo-album-cf
```

This copy-deployment script is manual. The TWO CodePipelines previously built
still provide automatic deployment of the original functions and website.

Keep required demo services running for the 2–3 days specified by the course.
After grading, manually empty ONLY the copied buckets before deleting the
copy stack; CloudFormation cannot delete a nonempty S3 bucket. Delete the
bootstrap artifact bucket after no stack needs its packages. Do not empty or
delete the original assignment buckets by mistake. The external OpenSearch
index `photos-cf-demo` is not removed when this stack is deleted.

## Troubleshooting

- **Preflight reports OPENSEARCH_INDEX/PHOTO_BUCKET:** make the source edits
  above, push, and download the updated complete repository ZIP again.
- **AccessDenied:** inspect the first failed stack event, not just the final
  rollback message. Send the resource name and error text for diagnosis.
- **Public bucket policy denied:** account-level S3 Block Public Access may
  prevent website hosting. Check account settings; do not expose photos S3.
- **Copied index/search gets OpenSearch 403:** the template grants the new IAM
  roles access to the separate index in the SAME account. The current domain
  must remain without fine-grained access control or an explicit Deny that
  overrides this. Check the copied function logs and domain policy. Role ARNs
  are in stack Outputs; do not make the domain anonymous/publicly writable.
- **Search before first upload gives an error:** the copied index does not yet
  exist. Upload a small valid JPG/PNG and inspect indexing logs first.
- **CREATE_COMPLETE but no index.html:** provisioning finished but frontend
  publishing did not; rerun `publish-cf-frontend.py` after resolving its error.
- **ROLLBACK_COMPLETE:** fix the failed resource cause before recreating that
  failed demo stack. Successful existing production resources are separate.

## Reference documentation

- https://docs.aws.amazon.com/cli/latest/reference/cloudformation/package.html
- https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-resource-function.html
- https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-apigateway-method-integration.html
- https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-s3-bucket-notificationconfiguration.html
- https://docs.aws.amazon.com/opensearch-service/latest/developerguide/ac.html
