# Security

## Pre-Commit
- No API keys, tokens, or credentials in source code
- Sanitize user input — prevent XSS (escape HTML output)
- Use CSRF protection on state-changing endpoints
- Verify authentication and authorization on every protected route

## Secrets
- Store in environment variables only
- Use `.env` files locally (never committed — must be in `.gitignore`)
- Rotate secrets immediately if exposed

## Incident Response
1. Stop the bleeding (disable affected endpoint/key)
2. Run security scan on affected code
3. Fix CRITICAL and HIGH findings immediately
4. Rotate any exposed secrets
5. Grep for impact scope across the codebase
