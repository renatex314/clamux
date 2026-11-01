# clamux remote bridge — infrastructure

This is an orphan branch of [clamux](https://github.com/renatex314/clamux): it shares no history with `main` and holds only the infrastructure for controlling a local clamux from a phone.

```
Phone (Android app) --HTTPS--> Relay (AWS, k3s) <--WebSocket (outbound)-- Connector (on my machine) --> clamux SDK
```

- **Connector** runs next to clamux on my own machine and dials out to the relay, so my machine opens no inbound port.
- **Relay** authenticates the phone, forwards a fixed allowlist of operations (list, peek, ask, send) to the connector, and sends push notifications when a session goes idle or needs permission.
- **Android app** is the client.

## Infrastructure scope

- AWS, provisioned with Terraform: VPC with public subnets (no NAT gateway), one EC2 instance, Elastic IP
- k3s (self-managed Kubernetes) on that instance
- GitHub Actions for CI/CD, authenticating to AWS through OIDC
- DNS on Cloudflare, TLS through cert-manager and Let's Encrypt

## Status

Planning. No Terraform has been written yet. Goal: `terraform apply` in an empty directory brings up the whole environment.

## Security notes

Whoever controls the relay can run prompts in Claude Code on my machine, so the relay only forwards a closed set of operations, both the connector and the phone authenticate to it, and all traffic is TLS.
