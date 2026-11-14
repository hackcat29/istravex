# Shared proxy settings for the istravex-api upstream (included by
# istravex-api.conf and istravex-api.http.conf).
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $host;
# Overwrite, never append: the API rate-limits on the first X-Forwarded-For
# entry, so clients must not be able to supply it.
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_connect_timeout 5s;
proxy_read_timeout 30s;
client_max_body_size 128k;
