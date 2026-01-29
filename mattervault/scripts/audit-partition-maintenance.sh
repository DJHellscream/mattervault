#!/bin/bash
# Audit Partition Maintenance Script
# Creates future monthly partitions for audit.chat_query_logs
# Run monthly via cron: 0 0 1 * * /path/to/audit-partition-maintenance.sh
#
# Usage: ./audit-partition-maintenance.sh [months_ahead]
#   months_ahead: Number of months to create partitions for (default: 3)

set -euo pipefail

# Configuration
DB_HOST="${CHATUI_DB_HOST:-matterdb-chatui}"
DB_PORT="${CHATUI_DB_PORT:-5432}"
DB_NAME="${CHATUI_DB_NAME:-chatui}"
DB_USER="${CHATUI_DB_USER:-chatui}"
MONTHS_AHEAD="${1:-3}"

echo "=== Audit Partition Maintenance ==="
echo "Database: ${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo "Creating partitions for next ${MONTHS_AHEAD} months"
echo ""

# Function to create partition for a given month
create_partition() {
    local year=$1
    local month=$2
    local next_year=$year
    local next_month=$((month + 1))

    # Handle year rollover
    if [ $next_month -gt 12 ]; then
        next_month=1
        next_year=$((year + 1))
    fi

    # Format with leading zeros
    local month_padded=$(printf "%02d" $month)
    local next_month_padded=$(printf "%02d" $next_month)

    local partition_name="chat_query_logs_${year}_${month_padded}"
    local start_date="${year}-${month_padded}-01"
    local end_date="${next_year}-${next_month_padded}-01"

    echo "Creating partition: audit.${partition_name} (${start_date} to ${end_date})"

    # Use docker exec if running from host, otherwise direct psql
    if command -v docker &> /dev/null && docker ps --filter name="${DB_HOST}" --format '{{.Names}}' | grep -q "${DB_HOST}"; then
        docker exec "${DB_HOST}" psql -U "${DB_USER}" -d "${DB_NAME}" -c "
            CREATE TABLE IF NOT EXISTS audit.${partition_name}
            PARTITION OF audit.chat_query_logs
            FOR VALUES FROM ('${start_date}') TO ('${end_date}');
        " 2>/dev/null || echo "  -> Partition already exists or error occurred"
    else
        PGPASSWORD="${CHATUI_DB_PASS:-chatui_secure_pass}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "
            CREATE TABLE IF NOT EXISTS audit.${partition_name}
            PARTITION OF audit.chat_query_logs
            FOR VALUES FROM ('${start_date}') TO ('${end_date}');
        " 2>/dev/null || echo "  -> Partition already exists or error occurred"
    fi
}

# Get current date
current_year=$(date +%Y)
current_month=$(date +%-m)

echo "Current date: ${current_year}-$(printf '%02d' ${current_month})"
echo ""

# Create partitions for the next N months
for i in $(seq 0 $((MONTHS_AHEAD - 1))); do
    target_month=$((current_month + i))
    target_year=$current_year

    # Handle year rollover
    while [ $target_month -gt 12 ]; do
        target_month=$((target_month - 12))
        target_year=$((target_year + 1))
    done

    create_partition $target_year $target_month
done

echo ""
echo "=== Partition maintenance complete ==="
