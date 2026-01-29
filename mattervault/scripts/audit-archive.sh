#!/bin/bash
# Audit Archive Script
# Archives audit log partitions older than retention period to compressed JSONL
# Run monthly via cron: 0 2 1 * * /path/to/audit-archive.sh
#
# Usage: ./audit-archive.sh [retention_years]
#   retention_years: Years to keep in database (default: 7)
#
# Archives are stored in: /workspace/mattervault/audit-archives/

set -euo pipefail

# Configuration
DB_HOST="${CHATUI_DB_HOST:-matterdb-chatui}"
DB_PORT="${CHATUI_DB_PORT:-5432}"
DB_NAME="${CHATUI_DB_NAME:-chatui}"
DB_USER="${CHATUI_DB_USER:-chatui}"
ARCHIVE_DIR="${AUDIT_ARCHIVE_DIR:-/workspace/mattervault/audit-archives}"
RETENTION_YEARS="${1:-7}"

echo "=== Audit Archive Script ==="
echo "Database: ${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo "Archive Directory: ${ARCHIVE_DIR}"
echo "Retention Period: ${RETENTION_YEARS} years"
echo ""

# Create archive directory if it doesn't exist
mkdir -p "${ARCHIVE_DIR}"

# Calculate cutoff date (retention_years ago from today)
cutoff_date=$(date -d "${RETENTION_YEARS} years ago" +%Y-%m-01 2>/dev/null || \
              date -v-${RETENTION_YEARS}y +%Y-%m-01 2>/dev/null || \
              echo "")

if [ -z "$cutoff_date" ]; then
    echo "ERROR: Could not calculate cutoff date. Check your system's date command."
    exit 1
fi

echo "Archiving partitions older than: ${cutoff_date}"
echo ""

# Function to run SQL (handles both Docker and direct connection)
run_sql() {
    local sql="$1"
    if command -v docker &> /dev/null && docker ps --filter name="${DB_HOST}" --format '{{.Names}}' | grep -q "${DB_HOST}"; then
        docker exec "${DB_HOST}" psql -U "${DB_USER}" -d "${DB_NAME}" -t -A -c "$sql"
    else
        PGPASSWORD="${CHATUI_DB_PASS:-chatui_secure_pass}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -A -c "$sql"
    fi
}

# Get list of partitions to archive
# Partition names are like: chat_query_logs_2026_01
echo "Checking for partitions to archive..."

partitions=$(run_sql "
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'audit'
      AND tablename LIKE 'chat_query_logs_%'
      AND tablename != 'chat_query_logs'
    ORDER BY tablename;
") || {
    echo "ERROR: Failed to query partitions"
    exit 1
}

archived_count=0
error_count=0

for partition in $partitions; do
    # Extract year and month from partition name (chat_query_logs_YYYY_MM)
    if [[ $partition =~ chat_query_logs_([0-9]{4})_([0-9]{2}) ]]; then
        year="${BASH_REMATCH[1]}"
        month="${BASH_REMATCH[2]}"
        partition_date="${year}-${month}-01"

        # Check if partition is older than cutoff
        if [[ "$partition_date" < "$cutoff_date" ]]; then
            echo "Archiving partition: audit.${partition} (${partition_date})"

            archive_file="${ARCHIVE_DIR}/${partition}.jsonl.gz"

            # Check if already archived
            if [ -f "$archive_file" ]; then
                echo "  -> Archive already exists: ${archive_file}"
                echo "  -> Skipping (delete archive file to re-archive)"
                continue
            fi

            # Export partition to JSONL and compress
            echo "  -> Exporting to ${archive_file}..."

            export_sql="
                COPY (
                    SELECT row_to_json(t)
                    FROM audit.${partition} t
                    ORDER BY created_at
                ) TO STDOUT;
            "

            if command -v docker &> /dev/null && docker ps --filter name="${DB_HOST}" --format '{{.Names}}' | grep -q "${DB_HOST}"; then
                docker exec "${DB_HOST}" psql -U "${DB_USER}" -d "${DB_NAME}" -c "$export_sql" | gzip > "${archive_file}" 2>/dev/null
            else
                PGPASSWORD="${CHATUI_DB_PASS:-chatui_secure_pass}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "$export_sql" | gzip > "${archive_file}" 2>/dev/null
            fi

            # Verify archive was created and has content
            if [ -f "$archive_file" ] && [ -s "$archive_file" ]; then
                # Get row count from archive
                archive_rows=$(zcat "$archive_file" | wc -l)
                echo "  -> Archived ${archive_rows} rows"

                # Drop the partition (data is now in archive)
                echo "  -> Dropping partition audit.${partition}..."
                run_sql "DROP TABLE IF EXISTS audit.${partition};" || {
                    echo "  -> WARNING: Failed to drop partition (archive preserved)"
                    error_count=$((error_count + 1))
                    continue
                }

                archived_count=$((archived_count + 1))
                echo "  -> Done"
            else
                echo "  -> ERROR: Archive file empty or not created"
                rm -f "$archive_file"  # Clean up empty file
                error_count=$((error_count + 1))
            fi
        fi
    fi
done

echo ""
echo "=== Archive Summary ==="
echo "Partitions archived: ${archived_count}"
echo "Errors: ${error_count}"
echo ""

# List archive directory contents
if [ -d "$ARCHIVE_DIR" ]; then
    echo "Archive directory contents:"
    ls -lh "${ARCHIVE_DIR}"/*.jsonl.gz 2>/dev/null || echo "  (no archives yet)"
fi

echo ""
echo "=== Archive complete ==="
