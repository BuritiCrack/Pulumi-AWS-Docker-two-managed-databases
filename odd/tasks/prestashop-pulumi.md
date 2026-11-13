# Modular PrestaShop infrastructure
Objective: implement AWS infrastructure using Pulumi TypeScript components, without deployment. Branch: feat/prestashop; delivery: feature-branch-chain (local only).
Checks: TypeScript compilation, Pulumi runtime mocks, Docker configuration checks, independent verification; AWS deployment requires a separate request.

## Specs
S1. "Vamos a crear la infractrucura con pulumi en aws de e-comerce prestashop contenerizada conectada a dos tipos diferentes de bases de datos gestionadas, por ejemplo PostgreSQL y Redis, en resumen Pulumi + AWS + Docker + dos bases de datos gestionadas."
S2. "la version de pulumi instalada es la v3.212.0."
S3. "respecto a las dbs a usar si, usemos Amazon RDS for MySQL/MariaDB: base de datos principal. y  Amazon ElastiCache for Redis OSS: caché, mediante un módulo o integración compatible con PrestaShop."
S4. "Antes de empezar a crear la infraestructura es super importante hacer uso de los ComponentResource y diseñar la infraestructura modular. La idea es construir infraestructura mediante bloques que tengan responsabilidades claras, en lugar de escribir todos los recursos de AWS, Azure o Kubernetes directamente en un enorme index.ts. Guiate de Context7 /websites/pulumi para la contruccion de la infra."
S5. "Vale empieza con la implementacio del codigo."

## Tasks
T1 | S1,S2,S4,S5 | parent: scaffold and configuration; network component with tests | in_progress | commit: pending
T2 | S1,S3,S4 | route pending: managed MySQL and Redis components with tests | pending | commit: pending
T3 | S1,S3,S4 | parent: container image/integration and storefront component with tests | pending | commit: pending
T4 | S1-S5 | parent: composition, configuration examples and operator documentation | pending | commit: pending
T5 | S1-S5 | independent verifier: functional/structural verification, then native review if required | pending | commit: pending

## Log
L1. Original request: "Vamos a crear la infractrucura con pulumi en aws de e-comerce prestashop contenerizada conectada a dos tipos diferentes de bases de datos gestionadas, por ejemplo PostgreSQL y Redis, en resumen Pulumi + AWS + Docker + dos bases de datos gestionadas. Pero antes de empezar a crear la infraestrucutra dame los pasos para crear el user iam con el que se creara la infra."
L2. User clarified S3 supersedes PostgreSQL. User confirmed AWS CLI installed and profile configured. Do not read credentials.
L3. User authorized implementation with S5 after the modular architecture proposal: TypeScript, ECS Fargate, RDS MySQL, Redis OSS, private databases, persistent application storage; no AWS deployment.
L4. User selected "Ramas encadenadas desde una rama de trabajo (recomendado)". No push, PR creation, or deployment authorized. Forecast: approximately 900-1300 authored lines plus generated dependency lockfile; slices by coherent behavior, not arbitrary line truncation.
L5. Initial inspection: workspace contains only .atl; not a Git repository. Node 24.12.0, npm 11.6.2, Pulumi 3.212.0. RDD enabled globally. Explorer researching compatible PrestaShop Redis integration before dependent implementation. Risk: item 2 (network/IAM/secrets) and item 5 (dependencies and deployable infrastructure).
L6. Routing: scaffold/configuration inline; reassess parallel independent network/data components after contracts established. ECS/image composition depends on integration research and follows inline. Required independent verifier runs once at feature end, before native review. Tests use mocks and do not create AWS resources. Remote build/deployment are not authorized.
