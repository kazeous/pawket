# Coolify runs Compose from a helper container, so repository files cannot be bind-mounted
# into production services. Bake the fail-closed scanner configuration into the image instead.
FROM clamav/clamav:1.5.4-debian@sha256:9bb8712a50f0e75166e936c452cd82dd5e5be0b85586598930b5bbb84a99a578
COPY --chmod=0644 clamd.conf /etc/clamav/clamd.conf
