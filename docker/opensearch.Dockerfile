# Pinned by digest for a reproducible, tamper-evident base (Scorecard
# Pinned-Dependencies). The tag names the version the digest is, and Dependabot
# (docker ecosystem) bumps the two together, so neither goes stale.
FROM opensearchproject/opensearch:3.10.0@sha256:02d6d6e40c820ae08233b60540aa5d3d9364d64e2dc724e38d6c8c794879b2a0

RUN /usr/share/opensearch/bin/opensearch-plugin install --batch analysis-kuromoji
