#!/usr/bin/env python3
"""Migrate data from mattervault_documents (v1) to mattervault_documents_v2 with sparse vectors"""

import json
import subprocess
import re
import sys

def hash_code(s):
    """Simple hash function matching the JavaScript implementation"""
    h = 0
    for c in s:
        h = ((h << 5) - h + ord(c)) & 0x7FFFFFFF
    return h % 30000

def run_curl(url, method="GET", data=None):
    """Run curl via docker"""
    cmd = [
        "docker", "run", "--rm", "--network", "mattervault_matternet",
        "curlimages/curl:latest", "curl", "-s"
    ]
    if method != "GET":
        cmd.extend(["-X", method])
    if data:
        cmd.extend(["-H", "Content-Type: application/json", "-d", json.dumps(data)])
    cmd.append(url)

    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout

def main():
    print("Fetching points from v1 collection...")

    # Get all points with vectors
    response = run_curl(
        "http://mattermemory:6333/collections/mattervault_documents/points/scroll",
        "POST",
        {"limit": 100, "with_payload": True, "with_vector": True}
    )

    try:
        data = json.loads(response)
    except json.JSONDecodeError as e:
        print(f"Error parsing response: {e}")
        print(f"Response: {response[:500]}")
        sys.exit(1)

    points = data.get('result', {}).get('points', [])
    print(f"Found {len(points)} points to migrate")

    success = 0
    errors = 0

    for point in points:
        point_id = point['id']
        vector = point.get('vector', [])
        payload = point.get('payload', {})
        text = payload.get('text', '').lower()

        # Generate sparse vector from text
        words = re.split(r'\W+', text)
        words = [w for w in words if len(w) > 2]
        word_counts = {}
        for w in words:
            word_counts[w] = word_counts.get(w, 0) + 1

        indices = []
        values = []
        for word, count in word_counts.items():
            indices.append(hash_code(word))
            values.append(float(count))

        # Create upsert payload with named vectors
        upsert_data = {
            "points": [{
                "id": point_id,
                "vector": {
                    "dense": vector,
                    "bm25": {"indices": indices, "values": values}
                },
                "payload": payload
            }]
        }

        # Insert to v2
        result = run_curl(
            "http://mattermemory:6333/collections/mattervault_documents_v2/points",
            "PUT",
            upsert_data
        )

        if '"status":"ok"' in result:
            success += 1
            print(f"  [{success}/{len(points)}] Migrated point {point_id}")
        else:
            errors += 1
            print(f"  Error on point {point_id}: {result[:100]}")

    print(f"\nMigration complete: {success} succeeded, {errors} failed")

if __name__ == "__main__":
    main()
