# Custom n8n image with community nodes
FROM n8nio/n8n:2.4.4

# Install community reranker node for Ollama
# Install to n8n's custom extensions directory
USER root
RUN mkdir -p /home/node/.n8n/nodes && \
    cd /home/node/.n8n/nodes && \
    npm init -y && \
    npm install n8n-nodes-reranker-ollama && \
    chown -R node:node /home/node/.n8n

# Install PyPDF2 for large PDF splitting (>50 pages)
RUN apk add --no-cache py3-pip && \
    pip3 install --break-system-packages PyPDF2

USER node
