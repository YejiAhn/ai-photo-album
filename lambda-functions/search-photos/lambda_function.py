import json
import logging
import os
import re
import uuid
from urllib.parse import urlparse

import boto3
from botocore.config import Config
from opensearchpy import AWSV4SignerAuth, OpenSearch, RequestsHttpConnection

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["AWS_REGION"]
INDEX_NAME = "photos"
PHOTO_BUCKET = "yeji-ai-photo-album-photos-2026"

session = boto3.Session()
lex = session.client(
    "lexv2-runtime",
    region_name=REGION,
    config=Config(
        connect_timeout=3,
        read_timeout=10,
        retries={"total_max_attempts": 1},
    ),
)
s3 = session.client(
    "s3", region_name=REGION, config=Config(signature_version="s3v4")
)
host = urlparse(os.environ["OPENSEARCH_ENDPOINT"].strip()).hostname
if not host:
    raise ValueError("OPENSEARCH_ENDPOINT must be a valid HTTPS URL")

search_client = OpenSearch(
    hosts=[{"host": host, "port": 443}],
    http_auth=AWSV4SignerAuth(session.get_credentials(), REGION, "es"),
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection,
    timeout=10,
    max_retries=0,
)


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type,X-Api-Key",
        },
        "body": json.dumps(body, ensure_ascii=False),
    }


def parse_label_query(query, lex_keywords):
    """Supplement Lex for explicit search templates and one/two-label input.

    This is a deterministic fallback for supported wording, not a general
    natural-language parser. 'and', 'or', and commas separate labels.
    """
    text = query.strip().lower()
    match = re.match(
        r"^(?:please\s+)?"
        r"(?:show\s+me|find|search(?:\s+for)?|i\s+want\s+to\s+see)\s+"
        r"(?:(?:photos?|pictures?|images?)\s+(?:of\s+)?)?"
        r"(.+)$",
        text,
    )

    # Retain Lex's extraction for other phrasing it can already understand.
    has_separator = bool(re.search(r"\s+(?:and|or)\s+|,", text))
    if not match and lex_keywords and not has_separator:
        return lex_keywords, "lex"

    label_text = match.group(1) if match else text
    parts = re.split(r"\s+(?:and|or)\s+|,", label_text)
    if any(not part.strip() for part in parts) or len(parts) > 2:
        return [], "unsupported_query"

    candidates = list(dict.fromkeys(part.strip() for part in parts))
    if not candidates or candidates == [""]:
        return [], "empty_query"

    if set(candidates) == set(lex_keywords):
        return lex_keywords, "lex"
    return candidates, "query_pattern"


def extract_keywords(query):
    # Lex is still called first for every non-empty valid search request.
    lex_response = lex.recognize_text(
        botId=os.environ["LEX_BOT_ID"],
        botAliasId=os.environ["LEX_BOT_ALIAS_ID"],
        localeId=os.environ["LEX_LOCALE_ID"],
        sessionId=str(uuid.uuid4()),
        text=query,
    )
    intent = lex_response.get("sessionState", {}).get("intent") or {}
    logger.info("Lex intent: %s", intent.get("name"))

    lex_keywords = []
    if intent.get("name") == "SearchIntent":
        slots = intent.get("slots") or {}
        for name in ("keyword1", "keyword2"):
            value = (slots.get(name) or {}).get("value") or {}
            keyword = (
                value.get("originalValue")
                or value.get("interpretedValue")
                or ""
            ).strip().lower()
            if keyword and keyword not in lex_keywords:
                lex_keywords.append(keyword)

    keywords, source = parse_label_query(query, lex_keywords)
    logger.info("Lex keywords: %s", json.dumps(lex_keywords))
    logger.info("Keyword source: %s", source)
    logger.info("Search keywords: %s", json.dumps(keywords))
    return keywords


def search_photos(keywords):
    clauses = []
    for keyword in keywords:
        clauses.append({"term": {"labels.keyword": keyword}})
        clauses.append({"match_phrase": {"labels": keyword}})

    result = search_client.search(
        index=INDEX_NAME,
        body={
            "size": 100,
            "query": {"bool": {"should": clauses, "minimum_should_match": 1}},
        },
    )
    photos = []
    for hit in result["hits"]["hits"]:
        document = hit["_source"]
        if document["bucket"] != PHOTO_BUCKET:
            continue
        url = s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": document["bucket"], "Key": document["objectKey"]},
            ExpiresIn=3600,
        )
        photos.append({"url": url, "labels": document.get("labels", [])})
    logger.info("Returned photos: %d", len(photos))
    return photos


def lambda_handler(event, context):
    print("Deployment version: assignment3-v2")
    params = event.get("queryStringParameters") or {}
    query = params.get("q", "")
    if not isinstance(query, str):
        return response(400, {"message": "q must be a string"})
    query = query.strip()
    if not query:
        return response(200, {"results": []})
    if len(query) > 1024:
        return response(400, {"message": "Search query is too long"})
    try:
        keywords = extract_keywords(query)
        if not keywords:
            return response(200, {"results": []})
        return response(200, {"results": search_photos(keywords)})
    except Exception:
        logger.exception("Photo search failed")
        return response(500, {"message": "Photo search failed"})

