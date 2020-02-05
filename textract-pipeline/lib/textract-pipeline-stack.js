"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("@aws-cdk/core");
const events = require("@aws-cdk/aws-events");
const iam = require("@aws-cdk/aws-iam");
const aws_lambda_event_sources_1 = require("@aws-cdk/aws-lambda-event-sources");
const sns = require("@aws-cdk/aws-sns");
const sqs = require("@aws-cdk/aws-sqs");
const dynamodb = require("@aws-cdk/aws-dynamodb");
const lambda = require("@aws-cdk/aws-lambda");
const s3 = require("@aws-cdk/aws-s3");
class TextractPipelineStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        //**********SNS Topics******************************
        const jobCompletionTopic = new sns.Topic(this, 'JobCompletion');
        //**********IAM Roles******************************
        const textractServiceRole = new iam.Role(this, 'TextractServiceRole', {
            assumedBy: new iam.ServicePrincipal('textract.amazonaws.com')
        });
        textractServiceRole.addToPolicy(new iam.PolicyStatement().addResources(jobCompletionTopic.topicArn).addActions('sns:Publish'));
        //**********S3 Batch Operations Role******************************
        const s3BatchOperationsRole = new iam.Role(this, 'S3BatchOperationsRole', {
            assumedBy: new iam.ServicePrincipal('batchoperations.s3.amazonaws.com')
        });
        //**********S3 Bucket******************************
        //S3 bucket for input documents and output
        const contentBucket = new s3.Bucket(this, 'DocumentsBucket', { versioned: false });
        const existingContentBucket = new s3.Bucket(this, 'ExistingDocumentsBucket', { versioned: false });
        existingContentBucket.grantReadWrite(s3BatchOperationsRole);
        const inventoryAndLogsBucket = new s3.Bucket(this, 'InventoryAndLogsBucket', { versioned: false });
        inventoryAndLogsBucket.grantReadWrite(s3BatchOperationsRole);
        //**********DynamoDB Table*************************
        //DynamoDB table with links to output in S3
        const outputTable = new dynamodb.Table(this, 'OutputTable', {
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.String },
            sortKey: { name: 'outputType', type: dynamodb.AttributeType.String }
        });
        //DynamoDB table with links to output in S3
        const documentsTable = new dynamodb.Table(this, 'DocumentsTable', {
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.String },
            streamSpecification: dynamodb.StreamViewType.NewImage
        });
        //**********SQS Queues*****************************
        //DLQ
        const dlq = new sqs.Queue(this, 'DLQ', {
            visibilityTimeoutSec: 30, retentionPeriodSec: 1209600
        });
        //Input Queue for sync jobs
        const syncJobsQueue = new sqs.Queue(this, 'SyncJobs', {
            visibilityTimeoutSec: 30, retentionPeriodSec: 1209600, deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Input Queue for async jobs
        const asyncJobsQueue = new sqs.Queue(this, 'AsyncJobs', {
            visibilityTimeoutSec: 30, retentionPeriodSec: 1209600, deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Queue
        const jobResultsQueue = new sqs.Queue(this, 'JobResults', {
            visibilityTimeoutSec: 900, retentionPeriodSec: 1209600, deadLetterQueue: { queue: dlq, maxReceiveCount: 50 }
        });
        //Trigger
        jobCompletionTopic.subscribeQueue(jobResultsQueue);
        //**********Lambda Functions******************************
        // Helper Layer with helper functions
        const helperLayer = new lambda.LayerVersion(this, 'HelperLayer', {
            code: lambda.Code.asset('lambda/helper'),
            compatibleRuntimes: [lambda.Runtime.Python37],
            license: 'Apache-2.0',
            description: 'Helper layer.',
        });
        // Textractor helper layer
        const textractorLayer = new lambda.LayerVersion(this, 'Textractor', {
            code: lambda.Code.asset('lambda/textractor'),
            compatibleRuntimes: [lambda.Runtime.Python37],
            license: 'Apache-2.0',
            description: 'Textractor layer.',
        });
        //------------------------------------------------------------
        // S3 Event processor
        const s3Processor = new lambda.Function(this, 'S3Processor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/s3processor'),
            handler: 'lambda_function.lambda_handler',
            environment: {
                SYNC_QUEUE_URL: syncJobsQueue.queueUrl,
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl,
                DOCUMENTS_TABLE: documentsTable.tableName,
                OUTPUT_TABLE: outputTable.tableName
            }
        });
        //Layer
        s3Processor.addLayer(helperLayer);
        //Trigger
        s3Processor.addEventSource(new aws_lambda_event_sources_1.S3EventSource(contentBucket, {
            events: [s3.EventType.ObjectCreated]
        }));
        //Permissions
        documentsTable.grantReadWriteData(s3Processor);
        syncJobsQueue.grantSendMessages(s3Processor);
        asyncJobsQueue.grantSendMessages(s3Processor);
        //------------------------------------------------------------
        // S3 Batch Operations Event processor
        const s3BatchProcessor = new lambda.Function(this, 'S3BatchProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/s3batchprocessor'),
            handler: 'lambda_function.lambda_handler',
            environment: {
                DOCUMENTS_TABLE: documentsTable.tableName,
                OUTPUT_TABLE: outputTable.tableName
            },
            reservedConcurrentExecutions: 1,
        });
        //Layer
        s3BatchProcessor.addLayer(helperLayer);
        //Permissions
        documentsTable.grantReadWriteData(s3BatchProcessor);
        s3BatchProcessor.grantInvoke(s3BatchOperationsRole);
        s3BatchOperationsRole.addToPolicy(new iam.PolicyStatement().addAllResources().addActions("lambda:*"));
        //------------------------------------------------------------
        // Document processor (Router to Sync/Async Pipeline)
        const documentProcessor = new lambda.Function(this, 'TaskProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/documentprocessor'),
            handler: 'lambda_function.lambda_handler',
            environment: {
                SYNC_QUEUE_URL: syncJobsQueue.queueUrl,
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl
            }
        });
        //Layer
        documentProcessor.addLayer(helperLayer);
        //Trigger
        documentProcessor.addEventSource(new aws_lambda_event_sources_1.DynamoEventSource(documentsTable, {
            startingPosition: lambda.StartingPosition.TrimHorizon
        }));
        //Permissions
        documentsTable.grantReadWriteData(documentProcessor);
        syncJobsQueue.grantSendMessages(documentProcessor);
        asyncJobsQueue.grantSendMessages(documentProcessor);
        //------------------------------------------------------------
        // Sync Jobs Processor (Process jobs using sync APIs)
        const syncProcessor = new lambda.Function(this, 'SyncProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/syncprocessor'),
            handler: 'lambda_function.lambda_handler',
            reservedConcurrentExecutions: 1,
            timeout: 25,
            environment: {
                OUTPUT_TABLE: outputTable.tableName,
                DOCUMENTS_TABLE: documentsTable.tableName,
                AWS_DATA_PATH: "models"
            }
        });
        //Layer
        syncProcessor.addLayer(helperLayer);
        syncProcessor.addLayer(textractorLayer);
        //Trigger
        syncProcessor.addEventSource(new aws_lambda_event_sources_1.SqsEventSource(syncJobsQueue, {
            batchSize: 1
        }));
        //Permissions
        contentBucket.grantReadWrite(syncProcessor);
        existingContentBucket.grantReadWrite(syncProcessor);
        outputTable.grantReadWriteData(syncProcessor);
        documentsTable.grantReadWriteData(syncProcessor);
        syncProcessor.addToRolePolicy(new iam.PolicyStatement().addAllResources().addActions("textract:*"));
        //------------------------------------------------------------
        // Async Job Processor (Start jobs using Async APIs)
        const asyncProcessor = new lambda.Function(this, 'ASyncProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/asyncprocessor'),
            handler: 'lambda_function.lambda_handler',
            reservedConcurrentExecutions: 1,
            timeout: 60,
            environment: {
                ASYNC_QUEUE_URL: asyncJobsQueue.queueUrl,
                SNS_TOPIC_ARN: jobCompletionTopic.topicArn,
                SNS_ROLE_ARN: textractServiceRole.roleArn,
                AWS_DATA_PATH: "models"
            }
        });
        //asyncProcessor.addEnvironment("SNS_TOPIC_ARN", textractServiceRole.topicArn)
        //Layer
        asyncProcessor.addLayer(helperLayer);
        //Triggers
        // Run async job processor every 5 minutes
        const rule = new events.EventRule(this, 'Rule', {
            scheduleExpression: 'rate(2 minutes)',
        });
        rule.addTarget(asyncProcessor);
        //Run when a job is successfully complete
        asyncProcessor.addEventSource(new aws_lambda_event_sources_1.SnsEventSource(jobCompletionTopic));
        //Permissions
        contentBucket.grantRead(asyncProcessor);
        existingContentBucket.grantReadWrite(asyncProcessor);
        asyncJobsQueue.grantConsumeMessages(asyncProcessor);
        asyncProcessor.addToRolePolicy(new iam.PolicyStatement().addResource(textractServiceRole.roleArn).addAction('iam:PassRole'));
        asyncProcessor.addToRolePolicy(new iam.PolicyStatement().addAllResources().addAction("textract:*"));
        //------------------------------------------------------------
        // Async Jobs Results Processor
        const jobResultProcessor = new lambda.Function(this, 'JobResultProcessor', {
            runtime: lambda.Runtime.Python37,
            code: lambda.Code.asset('lambda/jobresultprocessor'),
            handler: 'lambda_function.lambda_handler',
            memorySize: 2000,
            reservedConcurrentExecutions: 50,
            timeout: 900,
            environment: {
                OUTPUT_TABLE: outputTable.tableName,
                DOCUMENTS_TABLE: documentsTable.tableName,
                AWS_DATA_PATH: "models"
            }
        });
        //Layer
        jobResultProcessor.addLayer(helperLayer);
        jobResultProcessor.addLayer(textractorLayer);
        //Triggers
        jobResultProcessor.addEventSource(new aws_lambda_event_sources_1.SqsEventSource(jobResultsQueue, {
            batchSize: 1
        }));
        //Permissions
        outputTable.grantReadWriteData(jobResultProcessor);
        documentsTable.grantReadWriteData(jobResultProcessor);
        contentBucket.grantReadWrite(jobResultProcessor);
        existingContentBucket.grantReadWrite(jobResultProcessor);
        jobResultProcessor.addToRolePolicy(new iam.PolicyStatement().addAllResources().addAction("textract:*"));
    }
}
exports.TextractPipelineStack = TextractPipelineStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGV4dHJhY3QtcGlwZWxpbmUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJ0ZXh0cmFjdC1waXBlbGluZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHFDQUFzQztBQUN0Qyw4Q0FBK0M7QUFDL0Msd0NBQXlDO0FBQ3pDLGdGQUFxSDtBQUNySCx3Q0FBeUM7QUFDekMsd0NBQXlDO0FBQ3pDLGtEQUFtRDtBQUNuRCw4Q0FBK0M7QUFDL0Msc0NBQXVDO0FBRXZDLE1BQWEscUJBQXNCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFFbEQsWUFBWSxLQUFvQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUNsRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixvREFBb0Q7UUFDcEQsTUFBTSxrQkFBa0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGVBQWUsQ0FBQyxDQUFDO1FBRWhFLG1EQUFtRDtRQUNuRCxNQUFNLG1CQUFtQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDcEUsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHdCQUF3QixDQUFDO1NBQzlELENBQUMsQ0FBQztRQUNILE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CLENBQUMsQ0FBQTtRQUVoQyxtQkFBbUIsQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxFQUFFLENBQUMsWUFBWSxDQUFDLGtCQUFrQixDQUFDLFFBQVEsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDO1FBRS9ILGtFQUFrRTtRQUNsRSxNQUFNLHFCQUFxQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsdUJBQXVCLEVBQUU7WUFDeEUsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFn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QUksQ0FBQyxLQUFLLENBQUMsMkJBQTJCLENBQUM7WUFDcEQsT0FBTyxFQUFFLGdDQUFnQztZQUN6QyxVQUFVLEVBQUUsSUFBSTtZQUNoQiw0QkFBNEIsRUFBRSxFQUFFO1lBQ2hDLE9BQU8sRUFBRSxHQUFHO1lBQ1osV0FBVyxFQUFFO2dCQUNYLFlBQVksRUFBRSxXQUFXLENBQUMsU0FBUztnQkFDbkMsZUFBZSxFQUFFLGNBQWMsQ0FBQyxTQUFTO2dCQUN6QyxhQUFhLEVBQUcsUUFBUTthQUN6QjtTQUNGLENBQUMsQ0FBQztRQUNILE9BQU87UUFDUCxrQkFBa0IsQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLENBQUE7UUFDeEMsa0JBQWtCLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxDQUFBO1FBQzVDLFVBQVU7UUFDVixrQkFBa0IsQ0FBQyxjQUFjLENBQUMsSUFBSSx5Q0FBYyxDQUFDLGVBQWUsRUFBRTtZQUNwRSxTQUFTLEVBQUUsQ0FBQztTQUNiLENBQUMsQ0FBQyxDQUFDO1FBQ0osYUFBYTtRQUNiLFdBQVcsQ0FBQyxrQkFBa0IsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFBO1FBQ2xELGNBQWMsQ0FBQyxrQkFBa0IsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFBO1FBQ3JELGFBQWEsQ0FBQyxjQUFjLENBQUMsa0JBQWtCLENBQUMsQ0FBQTtRQUNoRCxxQkFBcUIsQ0FBQyxjQUFjLENBQUMsa0JBQWtCLENBQUMsQ0FBQTtRQUN4RCxrQkFBa0IsQ0FBQyxlQUFlLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxFQUFFLENBQUMsZUFBZSxFQUFFLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUE7SUFDekcsQ0FBQztDQUNGO0FBelBELHNEQXlQQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBjZGsgPSByZXF1aXJlKCdAYXdzLWNkay9jb3JlJyk7XHJcbmltcG9ydCBldmVudHMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtZXZlbnRzJyk7XHJcbmltcG9ydCBpYW0gPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtaWFtJyk7XHJcbmltcG9ydCB7IFMzRXZlbnRTb3VyY2UsIFNxc0V2ZW50U291cmNlLCBTbnNFdmVudFNvdXJjZSwgRHluYW1vRXZlbnRTb3VyY2UgfSBmcm9tICdAYXdzLWNkay9hd3MtbGFtYmRhLWV2ZW50LXNvdXJjZXMnO1xyXG5pbXBvcnQgc25zID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLXNucycpO1xyXG5pbXBvcnQgc3FzID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLXNxcycpO1xyXG5pbXBvcnQgZHluYW1vZGIgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtZHluYW1vZGInKTtcclxuaW1wb3J0IGxhbWJkYSA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1sYW1iZGEnKTtcclxuaW1wb3J0IHMzID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLXMzJyk7XHJcblxyXG5leHBvcnQgY2xhc3MgVGV4dHJhY3RQaXBlbGluZVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcclxuXHJcbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5Db25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcclxuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xyXG5cclxuICAgIC8vKioqKioqKioqKlNOUyBUb3BpY3MqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcclxuICAgIGNvbnN0IGpvYkNvbXBsZXRpb25Ub3BpYyA9IG5ldyBzbnMuVG9waWModGhpcywgJ0pvYkNvbXBsZXRpb24nKTtcclxuXHJcbiAgICAvLyoqKioqKioqKipJQU0gUm9sZXMqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcclxuICAgIGNvbnN0IHRleHRyYWN0U2VydmljZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1RleHRyYWN0U2VydmljZVJvbGUnLCB7XHJcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCd0ZXh0cmFjdC5hbWF6b25hd3MuY29tJylcclxuICAgIH0pO1xyXG4gICAgY29uc29sZS5sb2codGV4dHJhY3RTZXJ2aWNlUm9sZSlcclxuICAgIFxyXG4gICAgdGV4dHJhY3RTZXJ2aWNlUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCgpLmFkZFJlc291cmNlcyhqb2JDb21wbGV0aW9uVG9waWMudG9waWNBcm4pLmFkZEFjdGlvbnMoJ3NuczpQdWJsaXNoJykpO1xyXG5cclxuICAgIC8vKioqKioqKioqKlMzIEJhdGNoIE9wZXJhdGlvbnMgUm9sZSoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxyXG4gICAgY29uc3QgczNCYXRjaE9wZXJhdGlvbnNSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdTM0JhdGNoT3BlcmF0aW9uc1JvbGUnLCB7XHJcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiYXRjaG9wZXJhdGlvbnMuczMuYW1hem9uYXdzLmNvbScpXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyoqKioqKioqKipTMyBCdWNrZXQqKioqKioqKioqKioqKioqKioqKioqKioqKioqKipcclxuICAgIC8vUzMgYnVja2V0IGZvciBpbnB1dCBkb2N1bWVudHMgYW5kIG91dHB1dFxyXG4gICAgY29uc3QgY29udGVudEJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ0RvY3VtZW50c0J1Y2tldCcsIHsgdmVyc2lvbmVkOiBmYWxzZX0pO1xyXG5cclxuICAgIGNvbnN0IGV4aXN0aW5nQ29udGVudEJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ0V4aXN0aW5nRG9jdW1lbnRzQnVja2V0JywgeyB2ZXJzaW9uZWQ6IGZhbHNlfSk7XHJcbiAgICBleGlzdGluZ0NvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoczNCYXRjaE9wZXJhdGlvbnNSb2xlKVxyXG5cclxuICAgIGNvbnN0IGludmVudG9yeUFuZExvZ3NCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdJbnZlbnRvcnlBbmRMb2dzQnVja2V0JywgeyB2ZXJzaW9uZWQ6IGZhbHNlfSk7XHJcbiAgICBpbnZlbnRvcnlBbmRMb2dzQnVja2V0LmdyYW50UmVhZFdyaXRlKHMzQmF0Y2hPcGVyYXRpb25zUm9sZSlcclxuXHJcbiAgICAvLyoqKioqKioqKipEeW5hbW9EQiBUYWJsZSoqKioqKioqKioqKioqKioqKioqKioqKipcclxuICAgIC8vRHluYW1vREIgdGFibGUgd2l0aCBsaW5rcyB0byBvdXRwdXQgaW4gUzNcclxuICAgIGNvbnN0IG91dHB1dFRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdPdXRwdXRUYWJsZScsIHtcclxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdkb2N1bWVudElkJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TdHJpbmcgfSxcclxuICAgICAgc29ydEtleTogeyBuYW1lOiAnb3V0cHV0VHlwZScsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU3RyaW5nIH1cclxuICAgIH0pO1xyXG5cclxuICAgIC8vRHluYW1vREIgdGFibGUgd2l0aCBsaW5rcyB0byBvdXRwdXQgaW4gUzNcclxuICAgIGNvbnN0IGRvY3VtZW50c1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsICdEb2N1bWVudHNUYWJsZScsIHtcclxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdkb2N1bWVudElkJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TdHJpbmcgfSxcclxuICAgICAgc3RyZWFtU3BlY2lmaWNhdGlvbjogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTmV3SW1hZ2VcclxuICAgIH0pO1xyXG5cclxuICAgIC8vKioqKioqKioqKlNRUyBRdWV1ZXMqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxyXG5cclxuICAgIC8vRExRXHJcbiAgICBjb25zdCBkbHEgPSBuZXcgc3FzLlF1ZXVlKHRoaXMsICdETFEnLCB7XHJcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0U2VjOiAzMCwgcmV0ZW50aW9uUGVyaW9kU2VjOiAxMjA5NjAwXHJcbiAgICB9KTtcclxuXHJcbiAgICAvL0lucHV0IFF1ZXVlIGZvciBzeW5jIGpvYnNcclxuICAgIGNvbnN0IHN5bmNKb2JzUXVldWUgPSBuZXcgc3FzLlF1ZXVlKHRoaXMsICdTeW5jSm9icycsIHtcclxuICAgICAgdmlzaWJpbGl0eVRpbWVvdXRTZWM6IDMwLCByZXRlbnRpb25QZXJpb2RTZWM6IDEyMDk2MDAsIGRlYWRMZXR0ZXJRdWV1ZSA6IHsgcXVldWU6IGRscSwgbWF4UmVjZWl2ZUNvdW50OiA1MH1cclxuICAgIH0pO1xyXG5cclxuICAgIC8vSW5wdXQgUXVldWUgZm9yIGFzeW5jIGpvYnNcclxuICAgIGNvbnN0IGFzeW5jSm9ic1F1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnQXN5bmNKb2JzJywge1xyXG4gICAgICB2aXNpYmlsaXR5VGltZW91dFNlYzogMzAsIHJldGVudGlvblBlcmlvZFNlYzogMTIwOTYwMCwgZGVhZExldHRlclF1ZXVlIDogeyBxdWV1ZTogZGxxLCBtYXhSZWNlaXZlQ291bnQ6IDUwfVxyXG4gICAgfSk7XHJcblxyXG4gICAgLy9RdWV1ZVxyXG4gICAgY29uc3Qgam9iUmVzdWx0c1F1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnSm9iUmVzdWx0cycsIHtcclxuICAgICAgdmlzaWJpbGl0eVRpbWVvdXRTZWM6IDkwMCwgcmV0ZW50aW9uUGVyaW9kU2VjOiAxMjA5NjAwLCBkZWFkTGV0dGVyUXVldWUgOiB7IHF1ZXVlOiBkbHEsIG1heFJlY2VpdmVDb3VudDogNTB9XHJcbiAgICB9KTtcclxuICAgIC8vVHJpZ2dlclxyXG4gICAgam9iQ29tcGxldGlvblRvcGljLnN1YnNjcmliZVF1ZXVlKGpvYlJlc3VsdHNRdWV1ZSk7XHJcblxyXG4gICAgLy8qKioqKioqKioqTGFtYmRhIEZ1bmN0aW9ucyoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKlxyXG5cclxuICAgIC8vIEhlbHBlciBMYXllciB3aXRoIGhlbHBlciBmdW5jdGlvbnNcclxuICAgIGNvbnN0IGhlbHBlckxheWVyID0gbmV3IGxhbWJkYS5MYXllclZlcnNpb24odGhpcywgJ0hlbHBlckxheWVyJywge1xyXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL2hlbHBlcicpLFxyXG4gICAgICBjb21wYXRpYmxlUnVudGltZXM6IFtsYW1iZGEuUnVudGltZS5QeXRob24zN10sXHJcbiAgICAgIGxpY2Vuc2U6ICdBcGFjaGUtMi4wJyxcclxuICAgICAgZGVzY3JpcHRpb246ICdIZWxwZXIgbGF5ZXIuJyxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIFRleHRyYWN0b3IgaGVscGVyIGxheWVyXHJcbiAgICBjb25zdCB0ZXh0cmFjdG9yTGF5ZXIgPSBuZXcgbGFtYmRhLkxheWVyVmVyc2lvbih0aGlzLCAnVGV4dHJhY3RvcicsIHtcclxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS90ZXh0cmFjdG9yJyksXHJcbiAgICAgIGNvbXBhdGlibGVSdW50aW1lczogW2xhbWJkYS5SdW50aW1lLlB5dGhvbjM3XSxcclxuICAgICAgbGljZW5zZTogJ0FwYWNoZS0yLjAnLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ1RleHRyYWN0b3IgbGF5ZXIuJyxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcblxyXG4gICAgLy8gUzMgRXZlbnQgcHJvY2Vzc29yXHJcbiAgICBjb25zdCBzM1Byb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1MzUHJvY2Vzc29yJywge1xyXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QeXRob24zNyxcclxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9zM3Byb2Nlc3NvcicpLFxyXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcclxuICAgICAgZW52aXJvbm1lbnQ6IHtcclxuICAgICAgICBTWU5DX1FVRVVFX1VSTDogc3luY0pvYnNRdWV1ZS5xdWV1ZVVybCxcclxuICAgICAgICBBU1lOQ19RVUVVRV9VUkw6IGFzeW5jSm9ic1F1ZXVlLnF1ZXVlVXJsLFxyXG4gICAgICAgIERPQ1VNRU5UU19UQUJMRTogZG9jdW1lbnRzVGFibGUudGFibGVOYW1lLFxyXG4gICAgICAgIE9VVFBVVF9UQUJMRTogb3V0cHV0VGFibGUudGFibGVOYW1lXHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgLy9MYXllclxyXG4gICAgczNQcm9jZXNzb3IuYWRkTGF5ZXIoaGVscGVyTGF5ZXIpXHJcbiAgICAvL1RyaWdnZXJcclxuICAgIHMzUHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBTM0V2ZW50U291cmNlKGNvbnRlbnRCdWNrZXQsIHtcclxuICAgICAgZXZlbnRzOiBbIHMzLkV2ZW50VHlwZS5PYmplY3RDcmVhdGVkIF1cclxuICAgIH0pKTtcclxuICAgIC8vUGVybWlzc2lvbnNcclxuICAgIGRvY3VtZW50c1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShzM1Byb2Nlc3NvcilcclxuICAgIHN5bmNKb2JzUXVldWUuZ3JhbnRTZW5kTWVzc2FnZXMoczNQcm9jZXNzb3IpXHJcbiAgICBhc3luY0pvYnNRdWV1ZS5ncmFudFNlbmRNZXNzYWdlcyhzM1Byb2Nlc3NvcilcclxuXHJcbiAgICAvLy0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxyXG5cclxuICAgIC8vIFMzIEJhdGNoIE9wZXJhdGlvbnMgRXZlbnQgcHJvY2Vzc29yXHJcbiAgICBjb25zdCBzM0JhdGNoUHJvY2Vzc29yID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnUzNCYXRjaFByb2Nlc3NvcicsIHtcclxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUHl0aG9uMzcsXHJcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmFzc2V0KCdsYW1iZGEvczNiYXRjaHByb2Nlc3NvcicpLFxyXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcclxuICAgICAgZW52aXJvbm1lbnQ6IHtcclxuICAgICAgICBET0NVTUVOVFNfVEFCTEU6IGRvY3VtZW50c1RhYmxlLnRhYmxlTmFtZSxcclxuICAgICAgICBPVVRQVVRfVEFCTEU6IG91dHB1dFRhYmxlLnRhYmxlTmFtZVxyXG4gICAgICB9LFxyXG4gICAgICByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zOiAxLFxyXG4gICAgfSk7XHJcbiAgICAvL0xheWVyXHJcbiAgICBzM0JhdGNoUHJvY2Vzc29yLmFkZExheWVyKGhlbHBlckxheWVyKVxyXG4gICAgLy9QZXJtaXNzaW9uc1xyXG4gICAgZG9jdW1lbnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHMzQmF0Y2hQcm9jZXNzb3IpXHJcbiAgICBzM0JhdGNoUHJvY2Vzc29yLmdyYW50SW52b2tlKHMzQmF0Y2hPcGVyYXRpb25zUm9sZSlcclxuICAgIHMzQmF0Y2hPcGVyYXRpb25zUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCgpLmFkZEFsbFJlc291cmNlcygpLmFkZEFjdGlvbnMoXCJsYW1iZGE6KlwiKSlcclxuXHJcbiAgICAvLy0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxyXG5cclxuICAgIC8vIERvY3VtZW50IHByb2Nlc3NvciAoUm91dGVyIHRvIFN5bmMvQXN5bmMgUGlwZWxpbmUpXHJcbiAgICBjb25zdCBkb2N1bWVudFByb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1Rhc2tQcm9jZXNzb3InLCB7XHJcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlB5dGhvbjM3LFxyXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL2RvY3VtZW50cHJvY2Vzc29yJyksXHJcbiAgICAgIGhhbmRsZXI6ICdsYW1iZGFfZnVuY3Rpb24ubGFtYmRhX2hhbmRsZXInLFxyXG4gICAgICBlbnZpcm9ubWVudDoge1xyXG4gICAgICAgIFNZTkNfUVVFVUVfVVJMOiBzeW5jSm9ic1F1ZXVlLnF1ZXVlVXJsLFxyXG4gICAgICAgIEFTWU5DX1FVRVVFX1VSTDogYXN5bmNKb2JzUXVldWUucXVldWVVcmxcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICAvL0xheWVyXHJcbiAgICBkb2N1bWVudFByb2Nlc3Nvci5hZGRMYXllcihoZWxwZXJMYXllcilcclxuICAgIC8vVHJpZ2dlclxyXG4gICAgZG9jdW1lbnRQcm9jZXNzb3IuYWRkRXZlbnRTb3VyY2UobmV3IER5bmFtb0V2ZW50U291cmNlKGRvY3VtZW50c1RhYmxlLCB7XHJcbiAgICAgIHN0YXJ0aW5nUG9zaXRpb246IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uLlRyaW1Ib3Jpem9uXHJcbiAgICB9KSk7XHJcblxyXG4gICAgLy9QZXJtaXNzaW9uc1xyXG4gICAgZG9jdW1lbnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGRvY3VtZW50UHJvY2Vzc29yKVxyXG4gICAgc3luY0pvYnNRdWV1ZS5ncmFudFNlbmRNZXNzYWdlcyhkb2N1bWVudFByb2Nlc3NvcilcclxuICAgIGFzeW5jSm9ic1F1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKGRvY3VtZW50UHJvY2Vzc29yKVxyXG5cclxuICAgIC8vLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcblxyXG4gICAgLy8gU3luYyBKb2JzIFByb2Nlc3NvciAoUHJvY2VzcyBqb2JzIHVzaW5nIHN5bmMgQVBJcylcclxuICAgIGNvbnN0IHN5bmNQcm9jZXNzb3IgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdTeW5jUHJvY2Vzc29yJywge1xyXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QeXRob24zNyxcclxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9zeW5jcHJvY2Vzc29yJyksXHJcbiAgICAgIGhhbmRsZXI6ICdsYW1iZGFfZnVuY3Rpb24ubGFtYmRhX2hhbmRsZXInLFxyXG4gICAgICByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zOiAxLFxyXG4gICAgICB0aW1lb3V0OiAyNSxcclxuICAgICAgZW52aXJvbm1lbnQ6IHtcclxuICAgICAgICBPVVRQVVRfVEFCTEU6IG91dHB1dFRhYmxlLnRhYmxlTmFtZSxcclxuICAgICAgICBET0NVTUVOVFNfVEFCTEU6IGRvY3VtZW50c1RhYmxlLnRhYmxlTmFtZSxcclxuICAgICAgICBBV1NfREFUQV9QQVRIIDogXCJtb2RlbHNcIlxyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIC8vTGF5ZXJcclxuICAgIHN5bmNQcm9jZXNzb3IuYWRkTGF5ZXIoaGVscGVyTGF5ZXIpXHJcbiAgICBzeW5jUHJvY2Vzc29yLmFkZExheWVyKHRleHRyYWN0b3JMYXllcilcclxuICAgIC8vVHJpZ2dlclxyXG4gICAgc3luY1Byb2Nlc3Nvci5hZGRFdmVudFNvdXJjZShuZXcgU3FzRXZlbnRTb3VyY2Uoc3luY0pvYnNRdWV1ZSwge1xyXG4gICAgICBiYXRjaFNpemU6IDFcclxuICAgIH0pKTtcclxuICAgIC8vUGVybWlzc2lvbnNcclxuICAgIGNvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoc3luY1Byb2Nlc3NvcilcclxuICAgIGV4aXN0aW5nQ29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShzeW5jUHJvY2Vzc29yKVxyXG4gICAgb3V0cHV0VGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHN5bmNQcm9jZXNzb3IpXHJcbiAgICBkb2N1bWVudHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoc3luY1Byb2Nlc3NvcilcclxuICAgIHN5bmNQcm9jZXNzb3IuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KCkuYWRkQWxsUmVzb3VyY2VzKCkuYWRkQWN0aW9ucyhcInRleHRyYWN0OipcIikpXHJcblxyXG4gICAgLy8tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuXHJcbiAgICAvLyBBc3luYyBKb2IgUHJvY2Vzc29yIChTdGFydCBqb2JzIHVzaW5nIEFzeW5jIEFQSXMpXHJcbiAgICBjb25zdCBhc3luY1Byb2Nlc3NvciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0FTeW5jUHJvY2Vzc29yJywge1xyXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QeXRob24zNyxcclxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuYXNzZXQoJ2xhbWJkYS9hc3luY3Byb2Nlc3NvcicpLFxyXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcclxuICAgICAgcmVzZXJ2ZWRDb25jdXJyZW50RXhlY3V0aW9uczogMSxcclxuICAgICAgdGltZW91dDogNjAsXHJcbiAgICAgIGVudmlyb25tZW50OiB7XHJcbiAgICAgICAgQVNZTkNfUVVFVUVfVVJMOiBhc3luY0pvYnNRdWV1ZS5xdWV1ZVVybCxcclxuICAgICAgICBTTlNfVE9QSUNfQVJOIDogam9iQ29tcGxldGlvblRvcGljLnRvcGljQXJuLFxyXG4gICAgICAgIFNOU19ST0xFX0FSTiA6IHRleHRyYWN0U2VydmljZVJvbGUucm9sZUFybixcclxuICAgICAgICBBV1NfREFUQV9QQVRIIDogXCJtb2RlbHNcIlxyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIC8vYXN5bmNQcm9jZXNzb3IuYWRkRW52aXJvbm1lbnQoXCJTTlNfVE9QSUNfQVJOXCIsIHRleHRyYWN0U2VydmljZVJvbGUudG9waWNBcm4pXHJcblxyXG4gICAgLy9MYXllclxyXG4gICAgYXN5bmNQcm9jZXNzb3IuYWRkTGF5ZXIoaGVscGVyTGF5ZXIpXHJcbiAgICAvL1RyaWdnZXJzXHJcbiAgICAvLyBSdW4gYXN5bmMgam9iIHByb2Nlc3NvciBldmVyeSA1IG1pbnV0ZXNcclxuICAgIGNvbnN0IHJ1bGUgPSBuZXcgZXZlbnRzLkV2ZW50UnVsZSh0aGlzLCAnUnVsZScsIHtcclxuICAgICAgc2NoZWR1bGVFeHByZXNzaW9uOiAncmF0ZSgyIG1pbnV0ZXMpJyxcclxuICAgIH0pO1xyXG4gICAgcnVsZS5hZGRUYXJnZXQoYXN5bmNQcm9jZXNzb3IpO1xyXG4gICAgLy9SdW4gd2hlbiBhIGpvYiBpcyBzdWNjZXNzZnVsbHkgY29tcGxldGVcclxuICAgIGFzeW5jUHJvY2Vzc29yLmFkZEV2ZW50U291cmNlKG5ldyBTbnNFdmVudFNvdXJjZShqb2JDb21wbGV0aW9uVG9waWMpKVxyXG4gICAgLy9QZXJtaXNzaW9uc1xyXG4gICAgY29udGVudEJ1Y2tldC5ncmFudFJlYWQoYXN5bmNQcm9jZXNzb3IpXHJcbiAgICBleGlzdGluZ0NvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoYXN5bmNQcm9jZXNzb3IpXHJcbiAgICBhc3luY0pvYnNRdWV1ZS5ncmFudENvbnN1bWVNZXNzYWdlcyhhc3luY1Byb2Nlc3NvcilcclxuICAgIGFzeW5jUHJvY2Vzc29yLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCgpLmFkZFJlc291cmNlKHRleHRyYWN0U2VydmljZVJvbGUucm9sZUFybikuYWRkQWN0aW9uKCdpYW06UGFzc1JvbGUnKSlcclxuICAgIGFzeW5jUHJvY2Vzc29yLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCgpLmFkZEFsbFJlc291cmNlcygpLmFkZEFjdGlvbihcInRleHRyYWN0OipcIikpXHJcblxyXG4gICAgLy8tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuXHJcbiAgICAvLyBBc3luYyBKb2JzIFJlc3VsdHMgUHJvY2Vzc29yXHJcbiAgICBjb25zdCBqb2JSZXN1bHRQcm9jZXNzb3IgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdKb2JSZXN1bHRQcm9jZXNzb3InLCB7XHJcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlB5dGhvbjM3LFxyXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5hc3NldCgnbGFtYmRhL2pvYnJlc3VsdHByb2Nlc3NvcicpLFxyXG4gICAgICBoYW5kbGVyOiAnbGFtYmRhX2Z1bmN0aW9uLmxhbWJkYV9oYW5kbGVyJyxcclxuICAgICAgbWVtb3J5U2l6ZTogMjAwMCxcclxuICAgICAgcmVzZXJ2ZWRDb25jdXJyZW50RXhlY3V0aW9uczogNTAsXHJcbiAgICAgIHRpbWVvdXQ6IDkwMCxcclxuICAgICAgZW52aXJvbm1lbnQ6IHtcclxuICAgICAgICBPVVRQVVRfVEFCTEU6IG91dHB1dFRhYmxlLnRhYmxlTmFtZSxcclxuICAgICAgICBET0NVTUVOVFNfVEFCTEU6IGRvY3VtZW50c1RhYmxlLnRhYmxlTmFtZSxcclxuICAgICAgICBBV1NfREFUQV9QQVRIIDogXCJtb2RlbHNcIlxyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIC8vTGF5ZXJcclxuICAgIGpvYlJlc3VsdFByb2Nlc3Nvci5hZGRMYXllcihoZWxwZXJMYXllcilcclxuICAgIGpvYlJlc3VsdFByb2Nlc3Nvci5hZGRMYXllcih0ZXh0cmFjdG9yTGF5ZXIpXHJcbiAgICAvL1RyaWdnZXJzXHJcbiAgICBqb2JSZXN1bHRQcm9jZXNzb3IuYWRkRXZlbnRTb3VyY2UobmV3IFNxc0V2ZW50U291cmNlKGpvYlJlc3VsdHNRdWV1ZSwge1xyXG4gICAgICBiYXRjaFNpemU6IDFcclxuICAgIH0pKTtcclxuICAgIC8vUGVybWlzc2lvbnNcclxuICAgIG91dHB1dFRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShqb2JSZXN1bHRQcm9jZXNzb3IpXHJcbiAgICBkb2N1bWVudHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoam9iUmVzdWx0UHJvY2Vzc29yKVxyXG4gICAgY29udGVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZShqb2JSZXN1bHRQcm9jZXNzb3IpXHJcbiAgICBleGlzdGluZ0NvbnRlbnRCdWNrZXQuZ3JhbnRSZWFkV3JpdGUoam9iUmVzdWx0UHJvY2Vzc29yKVxyXG4gICAgam9iUmVzdWx0UHJvY2Vzc29yLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCgpLmFkZEFsbFJlc291cmNlcygpLmFkZEFjdGlvbihcInRleHRyYWN0OipcIikpXHJcbiAgfVxyXG59XHJcbiJdfQ==
