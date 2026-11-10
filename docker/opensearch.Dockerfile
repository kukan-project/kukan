# Pinned by digest for a reproducible, tamper-evident base (Scorecard
# Pinned-Dependencies). The tag names the version the digest is, and Dependabot
# (docker ecosystem) bumps the two together, so neither goes stale.
FROM opensearchproject/opensearch:3.9.0@sha256:3b55f6b6249cfdb92b52ee59adc8a266203ba9ef9f5d82544fad6f1af2f3609e

RUN /usr/share/opensearch/bin/opensearch-plugin install --batch analysis-kuromoji
