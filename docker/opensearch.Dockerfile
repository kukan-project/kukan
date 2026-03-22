FROM opensearchproject/opensearch:3

RUN /usr/share/opensearch/bin/opensearch-plugin install --batch analysis-kuromoji
