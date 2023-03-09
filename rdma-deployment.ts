const getRDMAEnabledPodsDeploymentSpec = (repoName: string) => ({
  replicas: "2",
  selector: {
    matchLabels: {
      app: "rdma-enabled"
    }
  },
  template: {
    metadata: {
      labels: {
        app: "rdma-enabled"
      }
    },
    spec: {
      hostNetwork: true,
      strategy: {
        type: "Recreate"
      },
      container: [
        {
          name: "app",
          image: `${repoName}:latest`,
          volumeMount: [
            {
              mountPath: "/dev/shm",
              name: "dshm"
            }
          ],
          command: [
            "sleep"
          ],
          //You could change it to run benchmarks automatically.
          // ps: It's possible to get Nodes IPs before via DataAwsInstance and feed them in to distinguish between client and server.
          args: [
            "infinity"
          ],
          resources: {
            limits: {
              "vpc.amazonaws.com/efa": "1",
              "hugepages-2Mi": "10Gi",
              "memory": "200Gi",
              "cpu": "62"
            },
            requests: {
              "vpc.amazonaws.com/efa": "1",
              "hugepages-2Mi": "10Gi",
              "memory": "200Gi",
              "cpu": "62"
            }
          }
        }
      ],
      volume: [
        {
          name: "dshm",
          emptyDir: {
            medium: "Memory"
          }
        }
      ]
    }
  }
})

export default getRDMAEnabledPodsDeploymentSpec;