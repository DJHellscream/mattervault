# D:\CCC\Dockerfile
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

# 1. Install Basics + Docker CLI + Dependencies for Claude Native
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    git \
    openssh-client \
    nano \
    iputils-ping \
    dnsutils \
    # Claude Native needs these text processing tools
    ripgrep \
    && mkdir -p /etc/apt/keyrings \
    # Add Docker's official GPG key
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    # Set up the repository
    && echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    # Install Docker CLI
    && apt-get update && apt-get install -y docker-ce-cli

# 2. Install Node.js 20 (Still needed for your Dashboard project!)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# 3. Install Claude Code (NATIVE METHOD)
# We accept the license explicitly to run unattended
RUN curl -fsSL https://claude.ai/install.sh | bash

# 4. Add Claude to the global PATH
# The native installer puts it in /root/.local/bin, which isn't in PATH by default.
ENV PATH="/root/.local/bin:${PATH}"

# 5. Set Workspace
WORKDIR /workspace
CMD ["/bin/bash"]