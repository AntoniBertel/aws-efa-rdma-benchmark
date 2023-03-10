## Benchmarking RDMA in AWS EKS cluster (graviton3 + EFA 2.0)
The repository contains Terraform CDK code that sets up an EKS cluster and surrounding infrastructure. It also attaches EFA-powered nodes, installs the EFA Device Plugin as a DaemonSet, builds an image with EFA drivers and OpenMPI, and deploys it to run RDMA benchmarks. EFA and OpenMPI work both on plain nodes and in pods.

## Intro
Remote Direct Memory Access (RDMA) enables high-throughput and low-latency data transfer between servers by offloading operations to a networking card, which saves CPU cycles on copying data buffers. In the context of Kubernetes clusters, RDMA can be used to accelerate communication between pods, which can improve the performance of applications that require high throughput and low latency.

This repository contains Terraform scripts for setting up an EKS cluster and running RDMA tests on top of it. Terraform CDK is used with AWS and Kubernetes providers to prepare infrastructure, including the VPC, subnets, security groups, and the EKS cluster itself.

### Terraform manages
- EKS Cluster
    - AWS-managed node pool with EFA attached
    - Device plugin to support EFA (DaemonSet)
    - Deployment of two pods with EFA drivers and OpenMPI
    - Cluster IAM role with sufficient permissions
- Node group of two ARM m7g.16xlarge instances
    - Launch template based on Amazon Linux 2
    - EFA and OpenMPI drivers are installed
    - Placement group for a nodepool
    - NodePool IAM role with sufficient permissions
    - SSH key pair to access nodes
- VPC with two private and two public subnetworks
    - Two routing tabless
    - Security group allowing free traffic flow
    - Internet gateway
    - Two NAT gateways
- Docker Image based on Ubuntu with EFA and RDMA drivers pre-installed
    - A dedicated ECR Repository
    - Scripts to build and push an image into ECR Repository

### Results achieved on m7g.16xlarge nodes (PingPong)
#### On nodes directly
| Number of messages | Message size | Time spent | usec |
| ------------------ | ------------ | ---------- | ---------------- |
| 1m                 | 4            | 20.52s     | 10.26            |
| 1m                 | 16           | 20.59s     | 10.3             |
| 1m                 | 64           | 21.23s     | 10.62            |
| 1m                 | 256          | 21.30s     | 10.65            |
| 1m                 | 1024         | 21.48s     | 10.74            |
| 1m                 | 10240        | 25.68s     | 12.84            |
| 1m                 | 51200        | 34.48s     | 17.24            |
| 1m                 | 102400       | 89.79s     | 44.9             |

#### Inside EKS Pods
| Number of messages | Message size | Time spent | usec |
| ------------------ | ------------ | ---------- | ---------------- |
| 1m                 | 4            | 20.85s     | 10.43            |
| 1m                 | 16           | 20.79s     | 10.4             |
| 1m                 | 64           | 21.35s     | 10.68            |
| 1m                 | 256          | 21.50s     | 10.75            |
| 1m                 | 1024         | 21.79s     | 10.9             |
| 1m                 | 10240        | 26.11s     | 13.06            |
| 1m                 | 51200        | 35.32s     | 17.66            |
| 1m                 | 102400       | 90.54s     | 45.27            |


## Preparing environment
- AWS credentials or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
- Change SSH public key to your own or set in AWS_EC2_SSH_PUBLIC_KEY
- Terraform and cdktf CLI
- AWS CLI
- Docker
- Kubectl

## Set Up
- Clone the repo
- npm install && cdktf get 
- cdktf deploy
- Enjoy :)

## Cleaning Up
- cdktf destroy

## What's missing
RDMA benchmarks don't mimic production workload, please keep that in mind. 
PingPong is a very basic benchmark, https://github.com/linux-rdma/perftest is the one to use for better quality data.
