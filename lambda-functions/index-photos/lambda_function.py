import hashlib
import json
import os
from urllib.parse import unquote_plus, urlparse

import boto3
from opensearchpy import (
    AWSV4SignerAuth,
    OpenSearch,
    RequestsHttpConnection,
)
from opensearchpy.exceptions import RequestError


INDEX_NAME = "photos"

session = boto3.Session()
s3 = session.client("s3")
rekognition = session.client("rekognition")

endpoint = os.environ["OPENSEARCH_ENDPOINT"].strip()
host = urlparse(endpoint).hostname

if not host:
    raise ValueError("OPENSEARCH_ENDPOINT must be a valid HTTPS URL")

auth = AWSV4SignerAuth(
    session.get_credentials(),
    os.environ["AWS_REGION"],
    "es",
)

search_client = OpenSearch(
    hosts=[{"host": host, "port": 443}],
    http_auth=auth,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection,
    timeout=15,
    max_retries=1,
    retry_on_timeout=True,
)

index_ready = False


def ensure_index():
    """Create the index once per execution environment, if needed."""
    global index_ready

    if index_ready:
        return

    index_body = {
        "settings": {
            "number_of_shards": 1,
            "number_of_replicas": 0,
        },
        "mappings": {
            "properties": {
                "objectKey": {"type": "keyword"},
                "bucket": {"type": "keyword"},
                "createdTimestamp": {"type": "date"},
                "labels": {
                    "type": "text",
                    "analyzer": "english",
                    "fields": {
                        "keyword": {"type": "keyword"}
                    },
                },
            }
        },
    }

    try:
        search_client.indices.create(
            index=INDEX_NAME,
            body=index_body,
        )
        print("Created index:", INDEX_NAME)
    except RequestError as error:
        # Ignore only the case where the index already exists.
        if error.error != "resource_already_exists_exception":
            raise
        print("Index already exists:", INDEX_NAME)

    index_ready = True


def lambda_handler(event, context):
    processed = 0

    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = unquote_plus(record["s3"]["object"]["key"])

        if not key.lower().endswith((".jpg", ".jpeg", ".png")):
            print(f"Skipping unsupported file: {key}")
            continue

        ensure_index()

        # 1. Read custom labels from S3 metadata.
        head = s3.head_object(Bucket=bucket, Key=key)
        metadata = head.get("Metadata", {})

        custom_labels = [
            label.strip().lower()
            for label in metadata.get("customlabels", "").split(",")
            if label.strip()
        ]

        # 2. Detect labels using Rekognition.
        response = rekognition.detect_labels(
            Image={"S3Object": {"Bucket": bucket, "Name": key}},
            Features=["GENERAL_LABELS"],
        )

        detected_labels = [
            label["Name"].lower()
            for label in response["Labels"]
        ]

        document = {
            "objectKey": key,
            "bucket": bucket,
            "createdTimestamp": head["LastModified"].isoformat(),
            "labels": sorted(set(custom_labels + detected_labels)),
        }

        # 3. Use a stable ID for the same S3 object.
        document_id = hashlib.sha256(
            f"{bucket}/{key}".encode("utf-8")
        ).hexdigest()

        # 4. Save the document and wait until it is searchable.
        result = search_client.index(
            index=INDEX_NAME,
            id=document_id,
            body=document,
            refresh="wait_for",
        )

        print("Detected labels:", json.dumps(detected_labels))
        print("Custom labels:", json.dumps(custom_labels))
        print("Index result:", result["result"])
        print("Document ID:", document_id)

        # 5. Read it back to verify storage during development.
        stored = search_client.get(
            index=INDEX_NAME,
            id=document_id,
        )
        print("Stored document:", json.dumps(stored["_source"]))

        processed += 1

    return {"processed": processed}
