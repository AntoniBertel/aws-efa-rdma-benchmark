const EfaDaemonSet = {
    selector: {
      matchLabels: {
        name: "aws-efa-k8s-device-plugin"
      }
    },
    strategy: {
      type: "RollingUpdate"
    },
    template: {
      metadata: {
        annotations: {
          "scheduler.alpha.kubernetes.io/critical-pod": ""
        },
        labels: {
          name: "aws-efa-k8s-device-plugin"
        }
      },
      spec: {
        serviceAccountName: "default",
        toleration: [
          {
            key: "CriticalAddonsOnly",
            operator: "Exists"
          },
          {
            key: "aws.amazon.com/efa",
            operator: "Exists",
            effect: "NoSchedule"
          }
        ],
        priorityClassName: "system-node-critical",
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerm: [
                {
                  matchExpressions: [
                    {
                      key: "node.kubernetes.io/instance-type",
                      operator: "In",
                      values: [
                        "m7g.16xlarge",
                        "c5n.18xlarge"
                      ]
                    }
                  ]
                }
              ]
            }
          }
        },
        hostNetwork: true,
        container: [
          {
            // That's the AWS EKS repository
            image: "602401143452.dkr.ecr.us-west-2.amazonaws.com/eks/aws-efa-k8s-device-plugin:v0.3.3",
            name: "aws-efa-k8s-device-plugin",
            securityContext: {
              runAsNonRoot: false,
              allowPrivilegeEscalation: false,
              capabilities: {
                drop: [
                  "ALL"
                ]
              }
            },
            volumeMount: [
              {
                name: "device-plugin",
                mountPath: "/var/lib/kubelet/device-plugins"
              }
            ]
          }
        ],
        volume: [
          {
            name: "device-plugin",
            hostPath: {
              path: "/var/lib/kubelet/device-plugins"
            }
          }
        ]
      }
    }
  }

  export default EfaDaemonSet;