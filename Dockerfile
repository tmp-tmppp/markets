# Build stage: slim Node.js LTS base image with a pinned version, the major matching `engines` in package.json.

# Copy package.json and package-lock.json and run npm ci first, so the dependency layer is cached.

# Copy tsconfig.json and src/ (the composition root and the four layer folders: domain, usecases, adapters, web) and compile to dist/; no tests in the image.

# Runtime stage: the same pinned base image, production dependencies only and dist/ copied from the build stage.

# Run as the non-root node user.

# Expose the HTTP port and start node dist/main.js.
