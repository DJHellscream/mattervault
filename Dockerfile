# We use Ubuntu 22.04 as your "Blank Slate" OS
FROM ubuntu:22.04

# Avoid prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

# 1. Install essentials.
# We include 'git' and 'ssh' so Claude can manage version control for you.
RUN apt-get update && apt-get install -y \
    curl \
    git \
    openssh-client \
    nano \
    iputils-ping \
    dnsutils \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Node.js 20 (The engine Claude Code runs on)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# 3. Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# 4. Set the workspace
WORKDIR /workspace

# 5. Default to bash terminal
CMD ["/bin/bash"]
