# Pinned by digest for a reproducible, tamper-evident base (Scorecard
# Pinned-Dependencies). The digest below is opensearch 3.7.0; Dependabot
# (docker ecosystem) bumps it as the opensearchproject/opensearch:3 tag moves.
FROM opensearchproject/opensearch:3@sha256:44ba7ea58a319adf61c33ab16873f9ef5dbb30b291a832d375172f0b2d24e3c9

RUN /usr/share/opensearch/bin/opensearch-plugin install --batch analysis-kuromoji
