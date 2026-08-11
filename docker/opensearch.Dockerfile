# Pinned by digest for a reproducible, tamper-evident base (Scorecard
# Pinned-Dependencies). The digest below is opensearch 3.7.0; Dependabot
# (docker ecosystem) bumps it as the opensearchproject/opensearch:3 tag moves.
FROM opensearchproject/opensearch:3@sha256:bcc1797519726ceb6d651d4a3e60b7c30da91793914a8dfe75fd441d4f641509

RUN /usr/share/opensearch/bin/opensearch-plugin install --batch analysis-kuromoji
