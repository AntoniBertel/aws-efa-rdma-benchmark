import { EksClusterStack } from "./aws";
import { App } from "cdktf";

const dockerImageTag = "eks-rdma-image"

const app = new App();
const eksCluster = new EksClusterStack(app, "eks-rdma", "rdma-enabled-cluster", "us-east-1");
app.synth();
