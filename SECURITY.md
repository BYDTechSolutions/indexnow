# Security policy

## Reporting a vulnerability

Please email **sales.bydtech@gmail.com** with the details, instead of opening a
public issue. We will acknowledge the report and keep you posted on the fix.

## Scope

The IndexNow key is public by design: the protocol requires it to be served
from your site, and it only proves that you control that host. Leaking it does
not give anyone access to your site; at worst someone can submit your own URLs.
If that happens, generate a new key with `indexnow key --force` and deploy it.
