#!/usr/bin/env python3
"""Debug what the hybrid search returns for Harold's address query"""

import json
import subprocess
import re

def hash_code(s):
    h = 0
    for c in s:
        h = ((h << 5) - h + ord(c)) & 0x7FFFFFFF
    return h % 30000

def run_curl(url, method="GET", data=None):
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

query = "What is Harold Morrison's address?"
print(f"Query: {query}")
print("=" * 60)

# Get embedding
embed_resp = run_curl(
    "http://host.docker.internal:11434/api/embeddings",
    "POST",
    {"model": "bge-m3", "prompt": query}
)
embedding = json.loads(embed_resp)['embedding']

# Generate sparse vector
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
print(f"Sparse terms: {list(word_counts.keys())}")

# Run hybrid search
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
    "limit": 10,
    "with_payload": True
}

search_resp = run_curl(
    "http://mattermemory:6333/collections/mattervault_documents_v3/points/query",
    "POST",
    search_request
)

data = json.loads(search_resp)
points = data['result']['points']

print(f"\nHybrid search returned {len(points)} results:")
print("-" * 60)

for i, p in enumerate(points):
    pid = p['id']
    score = p.get('score', 0)
    text = p['payload'].get('text', '')[:150]
    has_address = 'willowbrook' in text.lower() or '8742' in text
    marker = " *** HAS ADDRESS ***" if has_address else ""
    print(f"\n[{i+1}] Point {pid} (score: {score:.4f}){marker}")
    print(f"    {text}...")
