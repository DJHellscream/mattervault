# Paperless-ngx Workflow Setup for Document Sync

## Document Updated Workflow

Configure Paperless-ngx to notify MatterVault when documents are updated.

### Setup Steps

1. Log into Paperless-ngx admin: http://localhost:8000/admin/

2. Navigate to: **Workflows** → **Add Workflow**

3. Create workflow:
   - **Name**: `Sync - Document Updated`
   - **Order**: 100
   - **Enabled**: ✓

4. Add Trigger:
   - Click **Add Trigger**
   - **Type**: Document Updated
   - **Filter**: (leave empty to match all documents)

5. Add Action:
   - Click **Add Action**
   - **Type**: Webhook
   - **URL**: `http://matterlogic:5678/webhook/document-added-v2`
   - **Body**:
     ```json
     {"doc_url": "http://paperless:8000/api/documents/{doc_pk}/", "title": "{title}"}
     ```
   - **Method**: POST

6. Save the workflow

### Verification

After saving, update a document in Paperless:
1. Edit any document's title or tags
2. Check n8n executions at http://localhost:5678
3. Confirm the ingestion workflow was triggered

### Notes

- The workflow reuses the existing `document-added-v2` webhook since the ingestion pipeline is now idempotent (delete-before-ingest)
- Documents are re-indexed automatically when updated
- No separate "Document Updated" webhook endpoint is needed
