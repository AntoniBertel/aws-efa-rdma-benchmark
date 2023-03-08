
import { IamRole } from "@cdktf/provider-aws/lib/iam-role"
import { dump } from "js-yaml"

const awsAuth = (role : IamRole) => ({
    "mapRoles": dump([
      {
        groups: [
          "system:bootstrappers",
          "system:nodes",
          "system:masters"
        ],
        rolearn: role.arn,
        username: "system:node:{{EC2PrivateDNSName}}"
      }
    ], {
      'sortKeys': false
    })
  })

  export default awsAuth