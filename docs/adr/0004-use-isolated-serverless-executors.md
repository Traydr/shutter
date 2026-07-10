# Use isolated serverless Executors

Shutter Control, imgproxy, Shutter Video, and Shutter PDF are separate
deployments from the outset. Video and PDF retain independent execution modules
and each invocation claims and completes at most one durable job before
returning, so their different resource profiles and failures remain isolated
while Railway Serverless keeps idle usage low.

