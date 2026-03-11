#!/usr/bin/env python3
"""Check if Harold's address exists in the v2 collection"""

import json
import subprocess

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

# Get all points
response = run_curl(
    "http://mattermemory:6333/collections/mattervault_documents_v2/points/scroll",
    "POST",
    {"limit": 100, "with_payload": True}
)

data = json.loads(response)
points = data['result']['points']

print(f"Total points: {len(points)}\n")
print("=" * 60)
print("Searching for 'Willowbrook' or '8742' (Harold's address)...")
print("=" * 60)

found = False
for p in points:
    text = p['payload'].get('text', '')
    context = p['payload'].get('context_text', '')

    if 'willowbrook' in text.lower() or 'willowbrook' in context.lower() or '8742' in text or '8742' in context:
        found = True
        print(f"\nFOUND in point {p['id']}:")
        print(f"  Text: {text[:200]}...")
        print(f"  Context preview: {context[:200]}...")

if not found:
    print("\nNOT FOUND - Harold's address is not in any chunk!")
    print("\nLet's see what IS in the chunks about Harold:")
    for p in points:
        text = p['payload'].get('text', '').lower()
        if 'harold' in text:
            print(f"\nPoint {p['id']} mentions Harold:")
            print(f"  {p['payload'].get('text', '')[:300]}")
