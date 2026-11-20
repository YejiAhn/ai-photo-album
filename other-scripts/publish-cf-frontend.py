#!/usr/bin/env python3
"""Publish a repository frontend copy configured for the CloudFormation API.

Uses the AWS CLI's existing authentication. Does not change repository UI files
or the production bucket. The generated SDK remains part of the application.
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REGION = 'us-east-1'
PROJECT_DIR = Path(__file__).resolve().parent.parent


def aws_json(*arguments):
    result = subprocess.run(
        ['aws', *arguments, '--region', REGION, '--output', 'json'],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


def configure_staging(frontend, api_url, api_key):
    sdk = frontend / 'sdk' / 'apigClient.js'
    source = sdk.read_text()
    source, count = re.subn(
        r'''var\s+invokeUrl\s*=\s*(['"])[^'"\r\n]+\1\s*;''',
        lambda _: 'var invokeUrl = ' + json.dumps(api_url) + ';',
        source,
    )
    if count != 1:
        raise ValueError('Expected one var invokeUrl in front-end/sdk/apigClient.js.')
    sdk.write_text(source)
    (frontend / 'config.js').write_text(
        '// Generated for the CloudFormation demo API.\n'
        'window.PHOTO_ALBUM_CONFIG = ' + json.dumps({'apiKey': api_key}) + ';\n'
    )


def main():
    stack_name = sys.argv[1] if len(sys.argv) > 1 else 'photo-album-cf'
    stack = aws_json('cloudformation', 'describe-stacks', '--stack-name', stack_name)['Stacks'][0]
    if stack['StackStatus'] not in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}:
        raise SystemExit('Stack is not ready: ' + stack['StackStatus'])
    outputs = {item['OutputKey']: item['OutputValue'] for item in stack['Outputs']}
    key = aws_json('apigateway', 'get-api-key', '--api-key', outputs['ApiKeyId'], '--include-value')['value']
    # Temporary staging includes the public demo API key; it is removed on exit.
    with tempfile.TemporaryDirectory(prefix='photo-album-cf-frontend-') as temp:
        staged = Path(temp) / 'front-end'
        shutil.copytree(PROJECT_DIR / 'front-end', staged,
                        ignore=shutil.ignore_patterns('.DS_Store', '__MACOSX', '.git', 'node_modules'))
        configure_staging(staged, outputs['ApiBaseURL'], key)
        subprocess.run([
            'aws', 's3', 'sync', str(staged), 's3://' + outputs['FrontendBucketName'] + '/',
            '--region', REGION, '--cache-control', 'no-cache', '--only-show-errors'
        ], check=True)
    print('Frontend published: ' + outputs['FrontendWebsiteURL'])
    print('This copy uses API: ' + outputs['ApiBaseURL'])
    print('Upload a new photo to this copy before searching its separate index.')


if __name__ == '__main__':
    main()
