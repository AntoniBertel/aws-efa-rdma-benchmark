import { CloudformationStack } from "@cdktf/provider-aws/lib/cloudformation-stack";
import { DataAwsAvailabilityZones } from "@cdktf/provider-aws/lib/data-aws-availability-zones";
import { DataAwsEksCluster } from "@cdktf/provider-aws/lib/data-aws-eks-cluster";
import { DataAwsEksClusterAuth } from "@cdktf/provider-aws/lib/data-aws-eks-cluster-auth";
import { EksCluster } from "@cdktf/provider-aws/lib/eks-cluster";
import { IamRolePolicyAttachment } from "@cdktf/provider-aws/lib/iam-role-policy-attachment";
import { InternetGateway } from "@cdktf/provider-aws/lib/internet-gateway";
import { InternetGatewayAttachment } from "@cdktf/provider-aws/lib/internet-gateway-attachment";
import { KeyPair } from "@cdktf/provider-aws/lib/key-pair";
import { NatGateway } from "@cdktf/provider-aws/lib/nat-gateway";
import { PlacementGroup } from "@cdktf/provider-aws/lib/placement-group";
import { RouteTable } from "@cdktf/provider-aws/lib/route-table";
import { RouteTableAssociation } from "@cdktf/provider-aws/lib/route-table-association";
import { SecurityGroup } from "@cdktf/provider-aws/lib/security-group";
import { Subnet } from "@cdktf/provider-aws/lib/subnet";
import { Vpc } from "@cdktf/provider-aws/lib/vpc";
import { Fn, TerraformStack } from "cdktf";
import { Construct } from "constructs";
import {
  provider
} from "./.gen/providers/aws";
import { Eip } from "./.gen/providers/aws/eip";
import { IamRole } from "@cdktf/provider-aws/lib/iam-role"
import {
  deployment,
  daemonset,
  configMap,
  provider as k8s
} from "./.gen/providers/kubernetes";

import EfaDaemonSet from "./efa-daemonset";
import getRDMAEnabledPodsDeploymentSpec from "./rdma-deployment"
import { EcrRepository } from "@cdktf/provider-aws/lib/ecr-repository";
import * as NullProvider from "./.gen/providers/null";
import * as path from 'path';
import { DataAwsCallerIdentity } from "@cdktf/provider-aws/lib/data-aws-caller-identity";

export class EksClusterStack extends TerraformStack {
  public eks: DataAwsEksCluster;
  public eksAuth: DataAwsEksClusterAuth;
  constructor(
    scope: Construct,
    id: string,
    clusterName = "rdma-enabled-cluster",
    region = "us-east-1"
  ) {
    super(scope, id);
    new provider.AwsProvider(this, "aws", {
      region,
      accessKey: process.env.AWS_ACCESS_KEY_ID || "EXAMPLE",
      secretKey: process.env.AWS_SECRET_ACCESS_KEY || "EXAMPLE"
    });

    // First let's build and push a k8s edma-enabled docker image because it's most errors prone part
    const me = new DataAwsCallerIdentity(this, "me", {});
    const ecrRepo = new EcrRepository(this, "ecr-repo", {
      name: "eks-rdma-images",
    })
    new NullProvider.provider.NullProvider(this, `null`, {});
    new NullProvider.resource.Resource(this, `BuildDockerImage`, { dependsOn: [me, ecrRepo] }).addOverride("provisioner", [
      {
        "local-exec": {
          working_dir: path.resolve(),
          command: `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${me.accountId}.dkr.ecr.${region}.amazonaws.com && docker build -t eks-rdma-images . && docker tag eks-rdma-images:latest ${ecrRepo.repositoryUrl}:latest && docker push ${ecrRepo.repositoryUrl}:latest`,
        },
      },
    ]);

    // We query available AZs and then pick one for EFA-enabled instances
    const availabilityZones = new DataAwsAvailabilityZones(this, "avaiability-zones", {
      state: "available"
    });

    const vpc = new Vpc(this, "eks-vpc", {
      cidrBlock: "10.0.0.0/16",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: {
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
        Name: "eks-vpc"
      }
    });

    // We could be just fine with private OR public subnets. Public are more convinient to ssh, having both for the future.
    const publicSubnets = ["10.0.50.0/25", "10.0.50.128/25"].map((cidr, index) => {
      return new Subnet(this, `public_${index}`, {
        vpcId: vpc.id,
        cidrBlock: cidr,
        availabilityZone: Fn.element(availabilityZones.names, index),
        mapPublicIpOnLaunch: true,
        tags: {
          Name: `public-subnet-${index}`,
          [`kubernetes.io/cluster/${clusterName}`]: "shared",
          "kubernetes.io/role/elb": "1",
        }
      });
    });

    const privateSubnets = ["10.0.0.0/25", "10.0.0.128/25"].map((cidr, index) => {
      return new Subnet(this, `private_${index}`, {
        vpcId: vpc.id,
        cidrBlock: cidr,
        availabilityZone: Fn.element(availabilityZones.names, index),
        mapPublicIpOnLaunch: false,
        tags: {
          Name: `private-subnet-${index}`,
          [`kubernetes.io/cluster/${clusterName}`]: "shared",
          "kubernetes.io/role/internal-elb": "1"
        }
      });
    });

    // us-east-1a has a low capacity, we better go with another AZ
    const DEFAULT_SUBNET = publicSubnets.find(subnet => subnet.availabilityZone !== "us-east-1a") || publicSubnets[0]
    const AVZ = DEFAULT_SUBNET.availabilityZone

    // Let's create a nat gateway for each private subnet
    privateSubnets.forEach((subnet, index) => {
      const natGateway = new NatGateway(this, `nat-gateway-${index}`, {
        allocationId: new Eip(this, `eip-${index}`, {}).id,
        connectivityType: "public",
        subnetId: subnet.id,
        tags: {
          Name: `nat-gateway-${index}`,
        }
      })
      const privateRouteTable = new RouteTable(this, `private-route-table-${index}`, {
        vpcId: vpc.id,
        route: [{
          cidrBlock: "0.0.0.0/0",
          gatewayId: natGateway.id
        }],
        tags: {
          Name: `route-table-${index}`,
        }
      })
      const routeTablePrivateSubnet = new RouteTableAssociation(this, `route-table-private-subnet-${index}`, {
        subnetId: subnet.id,
        routeTableId: privateRouteTable.id
      })

    })

    // To make instances accesible
    const internetGateway = new InternetGateway(this, "internet-gateway", {})
    const attachment = new InternetGatewayAttachment(this, "internet-gateway-attachment", {
      vpcId: vpc.id,
      internetGatewayId: internetGateway.id
    })

    const publicRouteTable = new RouteTable(this, "public-route-table", {
      vpcId: vpc.id,
      route: [{
        cidrBlock: "0.0.0.0/0",
        gatewayId: internetGateway.id
      }]
    })

    publicSubnets.forEach((subnet, index) => {
      const routeTablePublicSubnet = new RouteTableAssociation(this, `route-table-public-subnet-${index}`, {
        subnetId: subnet.id,
        routeTableId: publicRouteTable.id
      })
    })

    // Role we assign on EKS cluster itself, to be able to manipulate with instances, pull images, etc.
    const EKSClusterRole = new IamRole(this, "iam", {
      name: "EKSClusterRole",
      assumeRolePolicy: JSON.stringify({
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Principal": {
              "Service": "eks.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
          }
        ]
      })
    })

    const eksIAMPolicies = ["arn:aws:iam::aws:policy/AmazonEKSClusterPolicy", "arn:aws:iam::aws:policy/AmazonEKSServicePolicy", "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy", "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy", "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"].map((policy, index) => {
      return new IamRolePolicyAttachment(this, `ekspolicy-${index}`, {
        policyArn: policy,
        role: EKSClusterRole.name
      })
    })

    // All traffic and also from self - as a requirment for EFA RDMA
    const allAllowed = [{
      fromPort: 0,
      toPort: 0,
      protocol: '-1',
      cidrBlocks: ["0.0.0.0/0"]
    },
    {
      fromPort: 0,
      toPort: 0,
      protocol: '-1',
      selfAttribute: true
    }
    ]
    const allowAllSg = new SecurityGroup(this, 'EksClusterSecurityGroup', {
      name: `${clusterName}-cluster-sg`,
      vpcId: vpc.id,
      egress: allAllowed,
      ingress: allAllowed
    })


    const eksModule = new EksCluster(this, "eks", {
      name: clusterName,
      version: "1.25",
      roleArn: EKSClusterRole.arn,
      vpcConfig: {
        endpointPrivateAccess: true,
        endpointPublicAccess: true,
        securityGroupIds: [allowAllSg.id],
        subnetIds: [...publicSubnets.map(subnet => subnet.id)]
      },

      dependsOn: [vpc, EKSClusterRole, ...eksIAMPolicies]
    });

    this.eks = new DataAwsEksCluster(this, "eks-cluster", {
      name: eksModule.name,
      dependsOn: [eksModule]
    });

    this.eksAuth = new DataAwsEksClusterAuth(this, "eks-auth", {
      name: eksModule.name,
      dependsOn: [eksModule]
    });


    const NodeInstanceRole = new IamRole(this, "NodeInstanceRole", {
      name: "NodeInstanceRole",
      assumeRolePolicy: JSON.stringify({
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Principal": {
              "Service": "ec2.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
          }
        ]
      }),
      dependsOn: [eksModule]
    })

    const policyAttachments = ["arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy", "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy", "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly", "arn:aws:iam::aws:policy/service-role/AmazonEC2RoleforSSM", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"].map((policy, index) => {
      return new IamRolePolicyAttachment(this, `nodepoolpolicy-${index}`, {
        policyArn: policy,
        role: NodeInstanceRole.name
      })
    })

    //Replace here to your public key
    const sshKeyPair = new KeyPair(this, "ssh-key", {
      keyName: "rdma-nodepool-key",
      publicKey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDHt9uPCuAguq9zT4TkHusJmnkpyIdVdROOdEWbemOFyrZggbN1AVYhKIdO2vs4A8744Czvsl2uPP/B/SKJ20/I7rkuUsqpSple2oyziKmevaouIU0P1G+UjjkRWZENACKCwQAwu7QYd/hvY+wNlMd9kqAly+QiIjTDGeZobHozhPRNPj+9Iw2PKTU9pFg2gUTf36WOmFO2NuN+lNiL+odgoJcaOy0PxIFiMR5Clsm245oMfcJjdO4ylfGdvwQQBbji82APpoeZF7o5JkUigIY4mMtuUpU/RHsx1Fdy8VJLKTPyBCzN6DHFisPG3zcBpd7jla4ByegofXFi4QWc8BdBGSezOJihW9r72v+8ckrVNgzQKQeNfAOkw/BI4eTqBbpGQpcZ0HcwY1yLU6o+6rqS00jVdBEcZ85pmiBb16zUHNYl9YgIm8rt9PyklFVBh5aVd5VxbTvmeuPpF4F0v3OHE5hUTyOpy4Z5xD9fcul5j+6Mf5a8ke3sK0ZT8AxuG9HkrPY0eMWZMvzcHCm6qb2HO9HZJFcCG/CwO9ER3MUtBqeK7ksw54ga7a33XajLppPqNprxAhG1bBrPKW/fvRJ0nV7znPyDWL05z+nalAn8EPjYpHmwPjd66n/OuMXv01e9912DUyWBXpffWJae2mDiQLmAbp1CN/Y7LjblB+1kZQ== ntb@ntb-macbookpro.roam.internal"
    })

    // A requirmenet for EFA and besides it gives us better latencies
    const eksPlacementGroup = new PlacementGroup(this, "placement-group", {
      name: "eks-placement-group",
      strategy: "cluster"
    })

    const STACK_NAME = "aws-cloudformation-stack"
    const FORMATION_TAGS = [
      {
        "Key": "Name",
        "Value": "rdma-enabled-cluster-efa-ng-Node"
      },
      {
        "Key": "alpha.eksctl.io/nodegroup-name",
        "Value": "efa-ng"
      },
      {
        "Key": "alpha.eksctl.io/nodegroup-type",
        "Value": "managed"
      }
    ]
    const FORMATION_TAGS_AS_OBJECT = {}
    FORMATION_TAGS.reduce((accumulator, currentValue) => {
      (accumulator as any)[currentValue.Key] = currentValue.Value
      return accumulator
    }, FORMATION_TAGS_AS_OBJECT);

    // We need this piece because AWS provider doesn't yet allow creation of node-pools with custom template and with EFA attached
    const awsCloudFormationStack = new CloudformationStack(this, "aws-cloudformation-stack", {
      name: STACK_NAME,
      templateBody: JSON.stringify({
        "AWSTemplateFormatVersion": "2010-09-09",
        "Description": "EKS Managed Nodes with EFA",
        "Resources": {
          "LaunchTemplate": {
            "Type": "AWS::EC2::LaunchTemplate",
            "Properties": {
              "LaunchTemplateData": {
                "BlockDeviceMappings": [
                  {
                    "DeviceName": "/dev/xvda",
                    "Ebs": {
                      "Iops": 3000,
                      "Throughput": 125,
                      "VolumeSize": 100,
                      "VolumeType": "gp3"
                    }
                  }
                ],
                "KeyName": "rdma-nodepool-key",
                "MetadataOptions": {
                  "HttpPutResponseHopLimit": 2,
                  "HttpTokens": "optional"
                },
                "NetworkInterfaces": [...Array(1).keys()].map((index) => {
                  return {
                    "DeviceIndex": index,
                    "NetworkCardIndex": index,
                    "Groups": [allowAllSg.id],
                    "InterfaceType": "efa"
                  }
                }),
                "Placement": {
                  "GroupName": eksPlacementGroup.name
                },
                "TagSpecifications": ["instance", "volume", "network-interface"].map((resourceType) => {
                  return {
                    "ResourceType": resourceType,
                    "Tags": FORMATION_TAGS
                  }
                }),
                "UserData": "TUlNRS1WZXJzaW9uOiAxLjANCkNvbnRlbnQtVHlwZTogbXVsdGlwYXJ0L21peGVkOyBib3VuZGFyeT1mYjhjNjFmZDcxMDgxMjA0YWU2N2ZjNjQxNTk4OThlYWJkYzM0NzEwMmE3YjQ1YjhmZjIxMGEyZmVlYjQNCg0KLS1mYjhjNjFmZDcxMDgxMjA0YWU2N2ZjNjQxNTk4OThlYWJkYzM0NzEwMmE3YjQ1YjhmZjIxMGEyZmVlYjQNCkNvbnRlbnQtVHlwZTogdGV4dC9jbG91ZC1ib290aG9vaw0KQ29udGVudC1UeXBlOiBjaGFyc2V0PSJ1cy1hc2NpaSINCg0KY2xvdWQtaW5pdC1wZXIgb25jZSB5dW1fd2dldCB5dW0gaW5zdGFsbCAteSB3Z2V0CmNsb3VkLWluaXQtcGVyIG9uY2Ugd2dldF9lZmEgd2dldCAtcSAtLXRpbWVvdXQ9MjAgaHR0cHM6Ly9zMy11cy13ZXN0LTIuYW1hem9uYXdzLmNvbS9hd3MtZWZhLWluc3RhbGxlci9hd3MtZWZhLWluc3RhbGxlci1sYXRlc3QudGFyLmd6IC1PIC90bXAvYXdzLWVmYS1pbnN0YWxsZXItbGF0ZXN0LnRhci5negoKY2xvdWQtaW5pdC1wZXIgb25jZSB0YXJfZWZhIHRhciAteGYgL3RtcC9hd3MtZWZhLWluc3RhbGxlci1sYXRlc3QudGFyLmd6IC1DIC90bXAKcHVzaGQgL3RtcC9hd3MtZWZhLWluc3RhbGxlcgpjbG91ZC1pbml0LXBlciBvbmNlIGluc3RhbGxfZWZhIC4vZWZhX2luc3RhbGxlci5zaCAteSAtZwpwb3AgL3RtcC9hd3MtZWZhLWluc3RhbGxlcgoKY2xvdWQtaW5pdC1wZXIgb25jZSBlZmFfaW5mbyAvb3B0L2FtYXpvbi9lZmEvYmluL2ZpX2luZm8gLXAgZWZhCg0KLS1mYjhjNjFmZDcxMDgxMjA0YWU2N2ZjNjQxNTk4OThlYWJkYzM0NzEwMmE3YjQ1YjhmZjIxMGEyZmVlYjQtLQ0K"
              },
              "LaunchTemplateName": {
                "Fn::Sub": STACK_NAME
              }
            }
          },
          "ManagedNodeGroup": {
            "Type": "AWS::EKS::Nodegroup",
            "Properties": {
              "AmiType": "AL2_ARM_64",
              "ClusterName": clusterName,
              "InstanceTypes": [
                "m7g.16xlarge"
                // "m5dn.24xlarge"
              ],
              "Labels": {
                "alpha.eksctl.io/cluster-name": clusterName,
                "alpha.eksctl.io/nodegroup-name": "efa-ng",
                "role": "workers"
              },
              "LaunchTemplate": {
                "Id": {
                  "Ref": "LaunchTemplate"
                }
              },
              "NodeRole": NodeInstanceRole.arn,
              "NodegroupName": "efa-ng",
              "ScalingConfig": {
                "DesiredSize": 2,
                "MaxSize": 2,
                "MinSize": 2
              },
              "Subnets": [
                DEFAULT_SUBNET.id
              ],
              "Tags": FORMATION_TAGS_AS_OBJECT
            }
          },
        }
      }),
      dependsOn: [this.eks, allowAllSg, NodeInstanceRole, vpc]
    })

    new k8s.KubernetesProvider(this, "cluster", {
      host: this.eks.endpoint,
      clusterCaCertificate: Fn.base64decode(
        this.eks.certificateAuthority.get(0).data
      ),
      token: this.eksAuth.token
    });

    const EFADaemonset = new daemonset.Daemonset(this, "EFADaemonset", {
      metadata: {
        name: "aws-efa-k8s-device-plugin-daemonset",
        namespace: "kube-system"
      },
      spec: EfaDaemonSet,
      dependsOn: [this.eks]
    })

    // Uncomment if you use self-managed Node group, otherwice permissions are created for you
    // const EKSPermissions = new configMap.ConfigMap(this, "EKSPermissions", {
    //   metadata: {
    //     namespace: "kube-system",
    //     name: "aws-auth"
    //   },
    //   data: awsAuth(NodeInstanceRole)
    // })

    const RDMAEnabledPodsDeployment = new deployment.Deployment(this, "RDMAEnabledPodsDeployment", {
      metadata: {
        name: "rdma-enabled",
      },
      spec: getRDMAEnabledPodsDeploymentSpec(ecrRepo.repositoryUrl),
      dependsOn: [ecrRepo, this.eks, awsCloudFormationStack]
    })

  }
}
