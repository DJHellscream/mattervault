#!/usr/bin/env python3
"""Compare dense vs sparse vs hybrid search"""

import json
import subprocess
import re

def hash_code(s):
    h = 0
    for c in s:
        h = ((h << 5) - h + ord(c)) & 0x7FFFFFFF
    return h % 30000

def run_curl(url, method="GET", data=None):
    cmd = ["docker", "run", "--rm", "--network", "mattervault_matternet",
           "curlimages/curl:latest", "curl", "-s"]
    if method != "GET":
        cmd.extend(["-X", method])
    if data:
        cmd.extend(["-H", "Content-Type: application/json", "-d", json.dumps(data)])
    cmd.append(url)
    return subprocess.run(cmd, capture_output=True, text=True).stdout

query = "What is Harold Morrison's address?"
print(f"Query: {query}\n")

# Get embedding
embed_resp = run_curl("http://host.docker.internal:11434/api/embeddings", "POST",
                      {"model": "bge-m3", "prompt": query})
embedding = json.loads(embed_resp)['embedding']

# Generate sparse vector
words = re.split(r'\W+', query.lower())
words = [w for w in words if len(w) > 2]
word_counts = {}
for w in words:
    word_counts[w] = word_counts.get(w, 0) + 1
sparse = {"indices": [hash_code(w) for w in word_counts], "values": [float(c) for c in word_counts.values()]}

filter_cond = {"must": [{"key": "family_id", "match": {"value": "morrison"}}]}

# Dense only search
print("=" * 60)
print("DENSE ONLY (semantic):")
print("=" * 60)
dense_req = {
    "query": embedding,
    "using": "dense",
    "limit": 5,
    "filter": filter_cond,
    "with_payload": True
}
dense_resp = json.loads(run_curl("http://mattermemory:6333/collections/mattervault_documents/points/query", "POST", dense_req))
for i, p in enumerate(dense_resp['result']['points']):
    text = p['payload'].get('text', '')[:100]
    has_addr = 'willowbrook' in text.lower() or '8742' in text
    print(f"[{i+1}] {p['id']} (score: {p['score']:.4f}) {'*** ADDRESS ***' if has_addr else ''}")
    print(f"    {text}...")

# Sparse only search
print("\n" + "=" * 60)
print("SPARSE ONLY (BM25 keyword):")
print("=" * 60)
sparse_req = {
    "query": sparse,
    "using": "bm25",
    "limit": 5,
    "filter": filter_cond,
    "with_payload": True
}
sparse_resp = json.loads(run_curl("http://mattermemory:6333/collections/mattervault_documents/points/query", "POST", sparse_req))
for i, p in enumerate(sparse_resp['result']['points']):
    text = p['payload'].get('text', '')[:100]
    has_addr = 'willowbrook' in text.lower() or '8742' in text
    print(f"[{i+1}] {p['id']} (score: {p['score']:.4f}) {'*** ADDRESS ***' if has_addr else ''}")
    print(f"    {text}...")

# Check point 290012 sparse vector
print("\n" + "=" * 60)
print("Checking sparse vector for point 290012 (has 'Address:'):")
print("=" * 60)
point_resp = json.loads(run_curl("http://mattermemory:6333/collections/mattervault_documents/points/290012", "GET"))
point_data = point_resp['result']
bm25 = point_data.get('vector', {}).get('bm25', {})
print(f"Sparse indices count: {len(bm25.get('indices', []))}")
print(f"Expected hash for 'address': {hash_code('address')}")
print(f"'address' hash in indices: {hash_code('address') in bm25.get('indices', [])}")
