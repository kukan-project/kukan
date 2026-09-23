# Pinned by digest for a reproducible, tamper-evident base (Scorecard
# Pinned-Dependencies). The digest below is opensearch 3.7.0; Dependabot
# (docker ecosystem) bumps it as the opensearchproject/opensearch:3 tag moves.
FROM opensearchproject/opensearch:3@sha256:fafe3fc3587088674669235575aa166228c48bdb940294a8cdbbc1da75236a40

RUN /usr/share/opensearch/bin/opensearch-plugin install --batch analysis-kuromoji
