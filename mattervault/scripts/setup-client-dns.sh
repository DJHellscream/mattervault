#!/usr/bin/env bash
# Setup client machine DNS for MatterVault subdomain access (optional upgrade)
#
# Usage:
#   Linux/Mac: sudo ./setup-client-dns.sh <server-ip>
#   Windows:   Run PowerShell as admin, then:
#              Add-Content C:\Windows\System32\drivers\etc\hosts "<server-ip> mattervault.local"
#
# This is optional — port-based access works without DNS setup.

set -euo pipefail

SERVER_IP="${1:?Usage: $0 <server-ip>}"
HOSTNAME="${2:-mattervault.local}"

# Validate IP format
if ! echo "$SERVER_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: Invalid IP address '$SERVER_IP'"
  exit 1
fi

HOSTS_FILE="/etc/hosts"
ENTRY="$SERVER_IP $HOSTNAME"

# Check if already configured
if grep -qF "$HOSTNAME" "$HOSTS_FILE" 2>/dev/null; then
  echo "Warning: $HOSTNAME already exists in $HOSTS_FILE"
  grep "$HOSTNAME" "$HOSTS_FILE"
  echo ""
  echo "To update, remove the existing entry first, then re-run this script."
  exit 0
fi

echo "$ENTRY" >> "$HOSTS_FILE"
echo "Added to $HOSTS_FILE: $ENTRY"
echo ""
echo "You can now access MatterVault at:"
echo "  Chat UI:    https://$HOSTNAME"
echo "  Paperless:  https://$HOSTNAME:8000"
echo "  Dashboard:  https://$HOSTNAME:3006"
