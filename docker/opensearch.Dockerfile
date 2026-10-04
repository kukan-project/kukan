# Pinned by digest for a reproducible, tamper-evident base (Scorecard
# Pinned-Dependencies). The tag names the version the digest is, and Dependabot
# (docker ecosystem) bumps the two together, so neither goes stale.
FROM opensearchproject/opensearch:3.9.0@sha256:adfa61f85025d06b4aeb562e7e74fde7e31c437039c93c3862c17e9acebd6c7c

RUN /usr/share/opensearch/bin/opensearch-plugin install --batch analysis-kuromoji
