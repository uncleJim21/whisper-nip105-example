const asyncHandler = require('../middleware/async');
const crypto = require('crypto');
const { getServicePrice, submitService } = require('../lib/service');
const { createNewJobDocument, findJobRequestByPaymentHash, getIsInvoicePaid, generateInvoice } = require('../lib/nip105');
const { logState, sleep } = require('../lib/common');
const musicMetadata = require('music-metadata');
const {
    upload,
    extractAudioFromMp4,
    downloadRemoteFile,
    validateAudioSize,
    getAudioDuration
} = require('../lib/fileManagement');
const path = require('path');
const { TEMP_DIR } = require('../lib/fileManagement');

exports.postService = asyncHandler(async (req,res,next) =>{
    const authAllowed = req.body?.authAllowed;
    console.log(`postService req.body:`,JSON.stringify(req.body, null, 2));
    const service = req.params.service;
    if (authAllowed) {
        const fakePaymentHash = crypto.randomBytes(20).toString('hex');
        const price = await getServicePrice(service, 10);
        const fakeInvoice = { verify: "fakeURL", pr: "fakePaymentRequest", paymentHash: fakePaymentHash };
        await createNewJobDocument(service, fakeInvoice, fakePaymentHash, price);
        const doc = await findJobRequestByPaymentHash(fakePaymentHash);
        doc.status = "PAID";
        doc.state = "NOT_PAID";
        doc.requestData = req.body;
        if(req?.file?.path){
            doc.requestData["filePath"] = path.basename(req.file.path);
            await doc.save();
        } else {
            const remoteUrl = req.body?.remote_url;
            if (remoteUrl) {
                const urlObj = new URL(remoteUrl);
                const isMp4InPath = urlObj.pathname.toLowerCase().endsWith(".mp4");
                const isMp4InMimeType = urlObj.searchParams.get("mime") === "video/mp4";
                const isMp4 = isMp4InPath || isMp4InMimeType;
                const isMp3OrMp4 = urlObj.pathname.toLowerCase().endsWith(".mp3") || isMp4;
                console.log(`urlObj:${urlObj}`)
                if (!isMp3OrMp4) {
                    return res.status(400).send('Invalid file format. Only mp3 and mp4 are supported.');
                }
                const downloadedFilePath = await downloadRemoteFile(remoteUrl);
                var mp3Path = downloadedFilePath;
                console.log(`downloadedFilePath:${downloadedFilePath}`)
                console.log(`isMp4:${isMp4}`)
                if(isMp4){
                    mp3Path = downloadedFilePath.replace(".mp4", ".mp3");
                    await extractAudioFromMp4(downloadedFilePath, mp3Path);
                }
                if(!validateAudioSize(mp3Path)){
                    res.status(400).send("File is too large to transcribe. The limit is 25MB.")
                }
                const durationInSeconds = await getAudioDuration(mp3Path);
                const service = req.params.service;
                const invoice = await generateInvoice(service, durationInSeconds);
                doc.requestData["remote_url"] = remoteUrl;
                doc.requestData["filePath"] = path.basename(mp3Path);
            }
            await doc.save();
        }
        const successAction = {
            tag: "url",
            url: `${process.env.ENDPOINT}/${service}/${fakePaymentHash}/get_result`,
            description: "Open to get the confirmation code for your purchase."
        };
        res.status(200).send({paymentHash: fakePaymentHash, authCategory: req.body.authCategory, successAction});
        return;
    }
    try {
        const remoteUrl = req.body.remote_url;
        if (remoteUrl) {
            const urlObj = new URL(remoteUrl);
            const isMp4InPath = urlObj.pathname.toLowerCase().endsWith(".mp4");
            const isMp4InMimeType = urlObj.searchParams.get("mime") === "video/mp4";
            const isMp4 = isMp4InPath || isMp4InMimeType;
            const isMp3OrMp4 = urlObj.pathname.toLowerCase().endsWith(".mp3") || isMp4;
            console.log(`urlObj:${urlObj}`)
            if (!isMp3OrMp4) {
                return res.status(400).send('Invalid file format. Only mp3 and mp4 are supported.');
            }
            const downloadedFilePath = await downloadRemoteFile(remoteUrl);
            var mp3Path = downloadedFilePath;
            console.log(`downloadedFilePath:${downloadedFilePath}`)
            console.log(`isMp4:${isMp4}`)
            if(isMp4){
                mp3Path = downloadedFilePath.replace(".mp4", ".mp3");
                await extractAudioFromMp4(downloadedFilePath, mp3Path);
            }
            if(!validateAudioSize(mp3Path)){
                res.status(400).send("File is too large to transcribe. The limit is 25MB.")
            }
            const durationInSeconds = await getAudioDuration(mp3Path);
            const service = req.params.service;
            const invoice = await generateInvoice(service, durationInSeconds);
            const successAction = {
                tag: "url",
                url: `${process.env.ENDPOINT}/${service}/${invoice.paymentHash}/get_result`,
                description: "Open to get the confirmation code for your purchase."
            };
            const doc = await findJobRequestByPaymentHash(invoice.paymentHash);
            doc.requestData = req.body;
            doc.requestData["remote_url"] = remoteUrl;
            doc.requestData["filePath"] = path.basename(mp3Path);
            doc.state = "NOT_PAID";
            await doc.save();
            logState(service, invoice.paymentHash, "REQUESTED");
            res.status(402).send({...invoice, authCategory: req.body.authCategory, successAction});
        } else {
            const metadata = await musicMetadata.parseFile(req.file.path);
            const durationInSeconds = metadata.format.duration;
            console.log("MP3 duration in seconds:", durationInSeconds);
            if (!req.file) {
                return res.status(400).send('No file uploaded.');
            }
            const service = req.params.service;
            const uploadedFilePath = req.file.path;
            const isMp4InPath = uploadedFilePath.toLowerCase().endsWith(".mp4");
            const isMp4 = isMp4InPath;
            const isMp3OrMp4 = uploadedFilePath.toLowerCase().endsWith(".mp3") || isMp4;
            console.log(`uploadedFilePath:${uploadedFilePath}`)
            if (!isMp3OrMp4) {
                return res.status(400).send('Invalid file format. Only mp3 and mp4 are supported.');
            }
            var mp3Path = uploadedFilePath;
            if(isMp4){
                mp3Path = uploadedFilePath.replace(".mp4", ".mp3");
                await extractAudioFromMp4(uploadedFilePath, mp3Path);
            }
            if(!validateAudioSize(mp3Path)){
                res.status(400).send("File is too large to transcribe. The limit is 25MB.")
            }
            const invoice = await generateInvoice(service,durationInSeconds);
            const successAction = {
                tag: "url",
                url: `${process.env.ENDPOINT}/${service}/${invoice.paymentHash}/get_result`,
                description: "Open to get the confirmation code for your purchase."
            };
            console.log("invoice:",invoice)
            const doc = await findJobRequestByPaymentHash(invoice.paymentHash);
            doc.requestData = req.body;
            doc.requestData["filePath"] = path.basename(mp3Path);
            doc.state = "NOT_PAID";
            await doc.save();
            logState(service, invoice.paymentHash, "REQUESTED");
            res.status(402).send({...invoice, authCategory: req.body.authCategory, successAction});
        }
    } catch (e) {
        console.log(e.toString().substring(0, 150));
        res.status(500).send(e);
    }
});

exports.checkPayment = asyncHandler(async (req,res,next) =>{
    try {
        const paymentHash = req.params.payment_hash;
        const { isPaid, invoice } = await getIsInvoicePaid(paymentHash);

        res.status(200).json({ invoice, isPaid });
    } catch (e) {
        console.log(e.toString().substring(0, 50));
        res.status(500).send(e);
    }
});

exports.getResult = asyncHandler(async (req,res,next) =>{
    try {
        const service = req.params.service;
        const paymentHash = req.params.payment_hash;
        const authAllowed = req.body.authAllowed;
        const authCategory = req.body.authCategory;
        const shouldSkipPaidVerify = authCategory === 1;
        const { invoice, isPaid } = await getIsInvoicePaid(paymentHash, shouldSkipPaidVerify);
        const successAction =  {
            tag: "url",
            url: `${process.env.ENDPOINT}/${service}/${paymentHash}/get_result`,
            description: "Open to get the confirmation code for your purchase."
        };

        logState(service, paymentHash, "POLL");
        if (!authAllowed && !isPaid) {
            res.status(402).send({ ...invoice, isPaid, authCategory, successAction});
        } 
        else {
            const doc = await findJobRequestByPaymentHash(paymentHash);

            console.log(`requestData: ${JSON.stringify(doc.requestData, null, 2)}`);

            switch (doc.state) {
            case "WORKING":
                logState(service, paymentHash, "WORKING");
                res.status(202).send({state: doc.state, authCategory, paymentHash, successAction});
                break;
            case "ERROR":
            case "DONE":
                logState(service, paymentHash, doc.state);
                res.status(200).send({...doc.requestResponse, authCategory, paymentHash, successAction});
                break;
            default:
                logState(service, paymentHash, "PAID");
                const data = doc.requestData;
                // Use async/await to ensure sequential execution
                try {
                    const fullPath = path.join(TEMP_DIR, data.filePath);
                    const response = await submitService(service, { ...data, filePath: fullPath });
                    console.log(`requestResponse:`,response);
                    doc.requestResponse = response;
                    doc.state = "DONE";
                    console.log(`DONE ${service} ${paymentHash} ${response}`);
                    await doc.save();
                    console.log("Doc saved!")
                    res.status(200).send({...doc.requestResponse, authCategory, paymentHash, successAction});
                    return;
                } catch (e) {
                    doc.requestResponse = e;
                    doc.state = "ERROR";
                    await doc.save();
                    console.log("submitService error:", e)
                }

                await doc.save();
                res.status(202).send({ state: doc.state });
            }
        }
    } catch (e) {
    console.log(e.toString().substring(0, 300));
    res.status(500).send(e);
    }
});

exports.testLogger = asyncHandler(async (req, res, next) => {

    console.log(`postTest req.body:`, JSON.stringify(req.body, null, 2));
    if (req?.file) {
        console.log('Uploaded File Path:', req?.file?.path);
    }
    res.status(200).send({'test': 'test'});
});