# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-23

### Added
- Initial release of `n8n-nodes-telegram`.
- `Telethon API Credentials` for Telegram MTProto authentication (`api_id`, `api_hash`, phone, code, 2FA).
- `Telethon Trigger` node for incoming Telegram events via webhook.
- `Telethon Send Message` node for text and file (base64) sending.
- Local Python Telethon service bootstrap and health checks.

