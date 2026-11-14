# Component contracts

`index.ts` composes components; resource creation stays inside their constructors.
All components accept `ComponentResourceOptions`, parent their children, and register outputs.

| Component | Owns | Inputs | Outputs |
| --- | --- | --- | --- |
| Network | VPC, subnets, routing, application security group | Two distinct availability zones | VPC, public/data subnet IDs, application security group ID |
| Database | RDS MySQL, subnet/security groups, password secret | Network IDs, application security group, secret password, lab mode | Host, port, database/user names, password secret ARN |
| Cache | Redis OSS replication group, subnet/security groups, token secret | Network IDs, application security group, secret token, lab mode | Host, port, token secret ARN |
| Storefront | ECS, ALB, EFS, IAM, image repository/build and logs | Network IDs, database/cache outputs, administrator secret, allowed CIDRs | Store URL, cluster/service names |

## Network trade-off

This temporary lab uses public subnets for Fargate tasks so they can pull images and
reach AWS APIs without a NAT Gateway. Tasks have public IPs but no public inbound
rule: only the ALB security group can reach Apache. Managed data stays in isolated
subnets. Application egress permits HTTPS and the MySQL, Redis and NFS ports to the
data subnet CIDRs. DNS uses the VPC resolver.

Only the ALB is reachable from configured client CIDRs. This is a lab topology,
not a production reference architecture. Do not use it for real customer data or
payments. A production deployment needs HTTPS, security hardening, backups,
application-user privilege separation, HA, and a tested upgrade strategy.

## RDS physical identifier

`DatabaseArgs.identifier` optionally forwards an explicit AWS identifier; omission
preserves provider naming for existing callers. This stack supplies a stable
`shop-mysql-<stack>` name so saved update plans do not depend on provider-generated
RDS names. Stack names must be compatible with AWS RDS identifier constraints.
Only pin a name after checking state and AWS ownership/uniqueness; changing the
identifier of an existing database can replace it. The deployment correction was
made before any RDS instance existed, without deleting other partial resources.

Dependencies flow through Inputs/Outputs; explicit dependencies are reserved for
operational readiness not represented by values (routes, EFS mounts, IAM policies).
Credentials are Pulumi secrets stored in Secrets Manager, then injected through ECS
`secrets`, never plaintext environment entries in the task definition.
