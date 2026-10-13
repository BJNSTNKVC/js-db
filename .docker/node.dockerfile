# Use the Playwright image matching the installed playwright package, with Node.js and every browser it drives
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# Accept UID and GID as build arguments to match host user permissions
ARG UID
ARG GID

# Set environment variables for UID and GID to be used in RUN commands
ENV UID=${UID}
ENV GID=${GID}

# Create the directory the package is mounted into
RUN mkdir -p /var/www/html

# Set the working directory for all subsequent commands
WORKDIR /var/www/html

# Set npm cache to be writable
RUN npm config set cache /tmp/.npm --global

# Run as the host user so the files written into the mounted package stay theirs
USER ${UID}:${GID}

# Keep the container running so the suites can be run in it with docker exec
CMD ["sleep", "infinity"]
