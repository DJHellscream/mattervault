#!/usr/bin/env python3
"""Test hybrid search on mattervault_documents_v2"""

import json
import subprocess
import re

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
    query = "Harold Morrison address"
    print(f"Testing hybrid search for: '{query}'")
    print("=" * 50)

    # Get embedding from Ollama
    print("\n1. Getting dense embedding...")
    embed_response = run_curl(
        "http://host.docker.internal:11434/api/embeddings",
        "POST",
        {"model": "nomic-embed-text", "prompt": query}
    )
    embed_data = json.loads(embed_response)
    embedding = embed_data['embedding']
    print(f"   Got embedding with {len(embedding)} dimensions")

    # Generate sparse vector
    print("\n2. Generating sparse vector...")
    words = re.split(r'\W+', query.lower())
    words = [w for w in words if len(w) > 2]
    word_counts = {}
    for w in words:
        word_counts[w] = word_counts.get(w, 0) + 1

    indices = []
    values = []
    for word, count in word_counts.items():
        indices.append(hash_code(word))
        values.append(float(count))

    sparse_vector = {"indices": indices, "values": values}
    print(f"   Generated sparse vector with {len(indices)} terms")

    # Run hybrid search
    print("\n3. Running hybrid search with RRF fusion...")
    search_request = {
        "prefetch": [
            {
                "query": embedding,
                "using": "dense",
                "limit": 15,
                "filter": {"must": [{"key": "family_id", "match": {"value": "morrison"}}]}
            },
            {
                "query": sparse_vector,
                "using": "bm25",
                "limit": 15,
                "filter": {"must": [{"key": "family_id", "match": {"value": "morrison"}}]}
            }
        ],
        "query": {"fusion": "rrf"},
        "limit": 5,
        "with_payload": True
    }

    search_response = run_curl(
        "http://mattermemory:6333/collections/mattervault_documents_v2/points/query",
        "POST",
        search_request
    )

    try:
        search_data = json.loads(search_response)
    except json.JSONDecodeError as e:
        print(f"   Error parsing response: {e}")
        print(f"   Response: {search_response[:500]}")
        return

    result = search_data.get('result', [])
    print(f"   Response keys: {search_data.keys()}")
    print(f"   Result type: {type(result)}")

    # Handle different response formats
    if isinstance(result, list):
        points = result
    elif isinstance(result, dict):
        points = result.get('points', [])
        print(f"   Result dict keys: {result.keys()}")
    else:
        print(f"   Unexpected result: {str(result)[:200]}")
        points = []

    print(f"   Hybrid search returned {len(points)} results")

    print("\n4. Top results:")
    print("-" * 50)
    for i, p in enumerate(points):
        if isinstance(p, dict):
            text = p.get('payload', {}).get('text', '')[:100]
            score = p.get('score', 0)
            doc_title = p.get('payload', {}).get('document_title', 'Unknown')
        else:
            print(f"   Unexpected result format: {type(p)} - {str(p)[:100]}")
            continue
        print(f"\n   [{i+1}] Score: {score:.4f}")
        print(f"       Doc: {doc_title}")
        print(f"       Text: {text}...")

    print("\n" + "=" * 50)
    print("Hybrid search test PASSED!" if len(points) > 0 else "Hybrid search test FAILED!")

if __name__ == "__main__":
    main()
