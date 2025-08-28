// import AWS from "aws-sdk";

// AWS.config.update({
//   region: process.env.AWS_REGION,
//   credentials: {
//     accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
//     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
//   },
// });

// export async function sendAlert(subject: string, message: string): Promise<void> {
//   const sns = new AWS.SNS({ apiVersion: "2010-03-31" });

//   await sns
//     .publish({
//       Message: message,
//       Subject: subject,
//       TargetArn: process.env.SYNCING_SERVICE_ALERTS_TOPIC_ARN!,
//     })
//     .promise();
// }

export async function sendAlert(subject: string, message: string): Promise<void> {
  console.log("Alert:", subject, message);
}
