FROM node:20-alpine

RUN apk add --no-cache curl bash postgresql-client jq

WORKDIR /e2e

COPY test.sh /e2e/test.sh
RUN chmod +x /e2e/test.sh

# Keep container running for manual test execution
CMD ["tail", "-f", "/dev/null"]
