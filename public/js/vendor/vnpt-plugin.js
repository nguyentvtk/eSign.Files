/************************************************************************/
/*                      VNPT-CA PLUGIN                                  */
/************************************************************************/
// js version 1.0.0.7
functionId = {
    GetCertInfo: 0,
    SignXML: 1,
    SignPDF: 2,
    SignOFFICE: 3,
    SignCMS: 4,
    chooseFile: 5,
    setLicenseKey: 6,
    checkPlugin: 7,
    signArrData: 8,
    signHash: 9,
    signArrDataAdvanced: 10,
    getVersion: 11,
    SignPDFMultiplePages: 12,
    checkPluginAdvanced: 13,
    ValidateCertificate: 14,
    ValidateCertificateBase64: 15,
    CheckValidTime: 16,
    CheckValidTimeBase64: 17,
    CheckOCSP: 18,
    CheckOCSPBase64: 19,
    ShowCertificateViewer: 20,
    CheckCRL: 21,
    CheckCRLBase64: 22,
    SetLanguage: 23,
    Scan: 24,
    OpenDocument: 25,
    BatchScan: 26,
    HandleFile: 27,
    DeleteFile: 28,
    SetIgnoreListFiles: 29,
    GetAllFiles: 30,
    GetFilePreview: 31,
    UploadFile: 32,
    GetDataScanned: 33,
    CheckToken: 34,
    SetGetCertFromUsbToken: 35,
    SetGetCertByPkcs11: 36,
    SetShowCertListDialog: 37,
    ConvertOfficeToPdf: 38,
    GetComputerInfo: 39,
    ClearPinCache: 40
};

var ports = [4433, 4434, 4435, 9201, 9202];
var currentID = 0;
var webSocket;
var vnptCheckPluginCallback;
var pluginSignal;
var returnPluginSignal = "SignalReturn:";
// check plugin
var timeOut = 3000;
var checkPluginCall = -1; // -1 - chưa call, 1 - da call
var pluginStatus = 0; // -1: failed, 0: chưa check, 1: đã check
var checkPluginRejectCallback;

function functionName(fun) {
    var ret = fun.toString();
    ret = ret.substr('function '.length);
    ret = ret.substr(0, ret.indexOf('('));
    return ret;
}
function getLastError(data) {
    console.log(data);
}

function get_browser() {
    var ua = navigator.userAgent, tem,
        M = ua.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i) || [];
    if (/trident/i.test(M[1])) {
        tem = /\brv[ :]+(\d+)/g.exec(ua) || [];
        return { name: 'IE', version: (tem[1] || '') };
    }
    if (M[1] === 'Chrome') {
        tem = ua.match(/\b(OPR|Edge)\/(\d+)/);
        if (tem != null) {
            //return tem.slice(1).join(' ').replace('OPR', 'Opera');
            return {
                name: tem.slice(1)[0].replace('OPR', 'Opera'),
                version: tem.slice(1)[1]
            };
        }
    }
    M = M[2] ? [M[1], M[2]] : [navigator.appName, navigator.appVersion, '-?'];
    if ((tem = ua.match(/version\/(\d+)/i)) != null) M.splice(1, 1, tem[1]);
    //return M.join(' ');
    return {
        name: M[0],
        version: M[1]
    };
};
function get_browser_old() {
    var ua = navigator.userAgent, tem, M = ua.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i) || [];
    if (/trident/i.test(M[1])) {
        tem = /\brv[ :]+(\d+)/g.exec(ua) || [];
        return { name: 'IE', version: (tem[1] || '') };
    }
    if (M[1] === 'Chrome') {
        tem = ua.match(/\bOPR|Edge\/(\d+)/)
        if (tem != null) { return { name: 'Opera', version: tem[1] }; }
    }
    M = M[2] ? [M[1], M[2]] : [navigator.appName, navigator.appVersion, '-?'];
    if ((tem = ua.match(/version\/(\d+)/i)) != null) { M.splice(1, 1, tem[1]); }
    return {
        name: M[0],
        version: M[1]
    };
}
function getOsName() {
    var OSName = "Unknown";
    if (window.navigator.userAgent.indexOf("Windows NT 10.0") != -1) OSName = "Windows 10";
    if (window.navigator.userAgent.indexOf("Windows NT 6.2") != -1) OSName = "Windows 8";
    if (window.navigator.userAgent.indexOf("Windows NT 6.1") != -1) OSName = "Windows 7";
    if (window.navigator.userAgent.indexOf("Windows NT 6.0") != -1) OSName = "Windows Vista";
    if (window.navigator.userAgent.indexOf("Windows NT 5.1") != -1) OSName = "Windows XP";
    if (window.navigator.userAgent.indexOf("Windows NT 5.0") != -1) OSName = "Windows 2000";
    if (window.navigator.userAgent.indexOf("Mac") != -1) OSName = "MAC";
    if (window.navigator.userAgent.indexOf("X11") != -1) OSName = "UNIX";
    if (window.navigator.userAgent.indexOf("Linux") != -1) OSName = "Linux";
    return OSName;
}
// for IE
var iePlugin;
function VnptInternetExplorerCallback(result) {
    var resSplit = result.split("*");
    // check plugin
    if (checkPluginCall === 1) {
        checkPluginCall = -1;
        if (resSplit[0] === "1") {
            timeOut = 5000;
        }
    }
    //window[resSplit[1]](resSplit[0]);
    if (resSplit[0].indexOf(returnPluginSignal) !== -1) // check plugin advanced
    {
        var sigHex = resSplit[0].substr(returnPluginSignal.length, resSplit[0].length - returnPluginSignal.length);
        var validateRes = doVerify(pluginSignal, sigHex);
        if (validateRes) {
            window[resSplit[1]]("1");
        }
        else {
            window[resSplit[1]]("-1");
        }
    }
    else {
        window[resSplit[1]](resSplit[0]);
    }
}
var init = 0;
//var defaultPort = 0;
var vnpt_plugin = {
    connect: function (port, data) {
        if (get_browser().name === "IE" || get_browser().name === "MSIE") {
            if (navigator.userAgent.indexOf("Windows NT 10.0") !== -1) {
                if (webSocket == null || pluginStatus != 1) {
                    webSocket = new WebSocket("wss://localhost:" + port + "/plugin");
                    timer = setTimeout(function () {
                        var s = webSocket;
                        webSocket = null;
                        s.close();
                        currentID++;
                        vnpt_plugin.tryConnect();
                    }, timeOut);
                }
                else {
                    // do something when connected
                    webSocket.send(data);
                }

                // opened
                webSocket.onopen = function () {
                    pluginStatus = 1;
                    clearTimeout(timer); // clear 	            
                    webSocket.send(data);
                }
                // closed
                webSocket.onclose = function () {
                    pluginStatus = 0;
                }
                // message
                webSocket.onmessage = function (message) {
                    // handle data	     
                    var result = message.data;
                    var resSplit = result.split("*");
                    // check plugin
                    if (checkPluginCall === 1) {
                        checkPluginCall = -1;
                        if (resSplit[0] === "1") {
                            timeOut = 5000;
                        }
                    }
                    //window[resSplit[1]](resSplit[0]);
                    if (resSplit[0].indexOf(returnPluginSignal) !== -1) // check plugin advanced
                    {
                        var sigHex = resSplit[0].substr(returnPluginSignal.length, resSplit[0].length - returnPluginSignal.length);
                        var validateRes = doVerify(pluginSignal, sigHex);
                        if (validateRes) {
                            window[resSplit[1]]("1");
                        }
                        else {
                            window[resSplit[1]]("-1");
                        }
                    }
                    else {
                        window[resSplit[1]](resSplit[0]);
                    }
                }
                // error
                webSocket.onerror = function () {
                    pluginStatus = 0;
                }

            }
            else {
                //console.log("For IE < 11");
                try {
                    iePlugin = new ActiveXObject("InternetExplorerModule.Main");
                    var pluginEvents = iePlugin.PluginEvents();
                    pluginEvents.ScriptCallbackObject = VnptInternetExplorerCallback;
                    iePlugin.Execute(data);
                }
                catch (Err) {
                    //console.log(Err.description);
                    var obj = JSON.parse(data);
                    if (obj.functionID === 7) {
                        //VnptInternetExplorerCallback("-1");
                        window[obj.funcCallback]("-1");
                    }
                }
            }
        }
        else {
            return new Promise(function (success, reject) {
                if (currentID == 0) {
                    checkPluginRejectCallback = success;
                }
                if (webSocket == null || pluginStatus != 1) {
                    webSocket = new WebSocket("wss://localhost:" + port + "/plugin");
                    timer = setTimeout(function () {
                        var s = webSocket;
                        webSocket = null;
                        s.close();
                        currentID++;
                        vnpt_plugin.tryConnect(data, success, reject);
                    }, timeOut);
                }
                else {
                    // do something when connected
                    webSocket.send(data);
                }
                // opened
                webSocket.onopen = function () {
                    pluginStatus = 1;
                    clearTimeout(timer); // clear 	            
                    webSocket.send(data);
                }
                // closed
                webSocket.onclose = function () {
                    pluginStatus = 0;
                }
                // message
                webSocket.onmessage = function (message) {
                    // handle data	     
                    var result = message.data;
                    var resSplit = result.split("*");
                    // check plugin
                    if (checkPluginCall === 1) {
                        checkPluginCall = -1;
                        if (resSplit[0] === "1") {
                            timeOut = 5000;
                        }
                    }
                    // return
                    if (resSplit[1] === "callbackDefault") {
                        if (resSplit[0].indexOf(returnPluginSignal) !== -1) // check plugin advanced
                        {
                            var sigHex = resSplit[0].substr(returnPluginSignal.length, resSplit[0].length - returnPluginSignal.length);
                            var validateRes = doVerify(pluginSignal, sigHex);
                            if (validateRes) {
                                success("1");
                            }
                            else {
                                success("-1");
                            }
                        }
                        else {
                            success(resSplit[0]);
                        }
                    }
                    else {
                        if (resSplit[0].indexOf(returnPluginSignal) !== -1) // check plugin advanced
                        {
                            var sigHex = resSplit[0].substr(returnPluginSignal.length, resSplit[0].length - returnPluginSignal.length);
                            var validateRes = doVerify(pluginSignal, sigHex);
                            if (validateRes) {
                                window[resSplit[1]]("1");
                            }
                            else {
                                window[resSplit[1]]("-1");
                            }
                        }
                        else {
                            window[resSplit[1]](resSplit[0]);
                        }
                    }
                }
                // error
                webSocket.onerror = function () {
                    //console.log("Error");
                    pluginStatus = 0;
                    //reject("Catch Error");
                    if (currentID === 2) {
                        if (vnptCheckPluginCallback == null) {
                            reject("-1");
                        }
                        else {
                            vnptCheckPluginCallback("-1");
                        }
                    }
                }
            });
        }
    },
    tryConnect: function (data, success, reject) {
        if (currentID < 3) {
            // this.connect(ports[currentID], data).then(function (data) {
            // //defaultPort = currentID;
            // success(data);
            // }).catch(function (e) {
            // currentID = 0;
            // reject(e);
            // });
            if (get_browser().name === "IE" || get_browser().name === "MSIE") {
                this.connect(ports[currentID], data);
            }
            else {
                this.connect(ports[currentID], data).then(function (data) {
                    //defaultPort = currentID;
                    success(data);
                });
            }
        }
        else {
            //console.log("Can not connect plugin");
            currentID = 0
            if (get_browser().name === "IE" || get_browser().name === "MSIE") {
                vnptCheckPluginCallback("-1");
            }
            else {
                checkPluginRejectCallback("-1");
            }

            //success("-1");
        }
    },
    sendMessageToPlugin: function (data) {
        data.domain = window.location.hostname;
        if (data.domain === "") {
            data.domain = window.location.href;
        }
        var jsData = "";
        jsData += JSON.stringify(data);
        return this.connect(ports[currentID], jsData);
    },
    signXML: function (data, funcCallback, xmlSigner) {
        var callInfo = {};
        callInfo.functionID = functionId.SignXML;

        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }

        if (xmlSigner == null) {
            var args = [
                data
            ];
            callInfo.args = args;
        }
        else {
            var pramaters = JSON.stringify(xmlSigner);
            var args = [
                data,
                pramaters
            ];
            callInfo.args = args;
        }

        return this.sendMessageToPlugin(callInfo);
    },
    signOffice: function (data, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.SignOFFICE;

        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }

        var args = [
            data
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    signPdf: function (data, funcCallback, pdfSigner) {
        var callInfo = {};
        callInfo.functionID = functionId.SignPDF;

        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        if (pdfSigner == null) {
            var args = [
                data
            ];
            callInfo.args = args;
        }
        else {
            var pramaters = JSON.stringify(pdfSigner);
            var args = [
                data,
                pramaters
            ];
            callInfo.args = args;
        }

        return this.sendMessageToPlugin(callInfo);
    },
    SignPDFMultiplePages: function (data, funcCallback, pdfSigner) {
        var callInfo = {};
        callInfo.functionID = functionId.SignPDFMultiplePages;

        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        if (pdfSigner == null) {
            consle.log("Pdf signature options not found!");
            return;
        }
        else {
            var pramaters = JSON.stringify(pdfSigner);
            var args = [
                data,
                pramaters
            ];
            callInfo.args = args;
        }

        return this.sendMessageToPlugin(callInfo);
    },
    signCms: function (data, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.SignCMS;

        if (funcCallback !== null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }

        var args = [
            data
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    signHash: function (data, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.signHash;

        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }

        var args = [
            data
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    signArrDataAdvanced: function (arrData, serial, clearPINCache, funcCallback, showCertList) {
        var callInfo = {};
        var clearPIN = "0";
        if (clearPINCache != null && clearPINCache)
            clearPIN = "1";
        var isShowCertList = "1";
        if (showCertList != null && !showCertList)
            isShowCertList = "0";

        var jsArr = JSON.stringify(arrData);
        callInfo.functionID = functionId.signArrDataAdvanced;

        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            jsArr,
            serial,
            clearPIN,
            isShowCertList
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    signArrData: function (arrData, type, sigOption, serial, clearPINCache, funcCallback) {
        var callInfo = {};
        var clearPIN = "0";
        if (clearPINCache != null && clearPINCache)
            clearPIN = "1";
        var jsArr = JSON.stringify(arrData);
        callInfo.functionID = functionId.signArrData;

        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        /// pramaters
        if (sigOption == null) {
            var args = [
                jsArr,
                type,
                serial,
                clearPIN
            ];
            callInfo.args = args;
        }
        else {
            var sigOtions = JSON.stringify(sigOption);
            var args = [
                jsArr,
                type,
                serial,
                clearPIN,
                sigOtions
            ];
            callInfo.args = args;
        }
        return this.sendMessageToPlugin(callInfo);
    },
    getCertInfo: function (funcCallback, isOnyFromToken, serialNumber) {
        var callInfo = {};
        callInfo.functionID = functionId.GetCertInfo;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var isOnyToken = "0";
        if (isOnyFromToken !== null && isOnyFromToken)
            isOnyToken = "1";
        var args = [
            isOnyToken,
            serialNumber
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    chooseFile: function (funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.chooseFile;

        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }

        var args = [
            ""
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    setLicenseKey: function (license, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.setLicenseKey;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            license
        ];
        callInfo.args = args;
        // callInfo.domain = window.location.hostname;
        // if (callInfo.domain === "")
        // {
        // callInfo.domain = window.location.href;
        // }
        return this.sendMessageToPlugin(callInfo);
    },
    setLanguage: function (language, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.SetLanguage;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            language
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    SetGetCertFromUsbToken: function (isOnyFromToken, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.SetGetCertFromUsbToken;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var isOnyToken = "1";
        if (isOnyFromToken != null && !isOnyFromToken)
            isOnyToken = "0";
        var args = [
            isOnyToken
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    SetGetCertByPkcs11: function (usePkcs11, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.SetGetCertByPkcs11;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var isUsePkcs11 = "1";
        if (usePkcs11 != null && !usePkcs11)
            isUsePkcs11 = "0";
        var args = [
            isUsePkcs11
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    SetShowCertListDialog: function (isShowDialog, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.SetShowCertListDialog;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var showListCert = "1";
        if (isShowDialog != null && !isShowDialog)
            showListCert = "0";
        var args = [
            showListCert
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    ValidateCertificate: function (serialNumber, timeCheck, ocspUrl, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.ValidateCertificate;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            serialNumber,
            timeCheck,
            ocspUrl
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    ValidateCertificateBase64: function (certBase64, timeCheck, ocspUrl, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.ValidateCertificateBase64;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            certBase64,
            timeCheck,
            ocspUrl
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    CheckValidTime: function (serialNumber, timeCheck, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.CheckValidTime;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            serialNumber,
            timeCheck
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    CheckValidTimeBase64: function (certBase64, timeCheck, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.CheckValidTimeBase64;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            certBase64,
            timeCheck
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    ShowCertificateViewer: function (certBase64, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.ShowCertificateViewer;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            certBase64
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    CheckOCSP: function (serialNumber, timeCheck, ocspUrl, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.CheckOCSP;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            serialNumber,
            timeCheck,
            ocspUrl
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    CheckOCSPBase64: function (certBase64, timeCheck, ocspUrl, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.CheckOCSPBase64;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            certBase64,
            timeCheck,
            ocspUrl
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    CheckCRL: function (serialNumber, timeCheck, crlUrl, crlBase64, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.CheckCRL;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            serialNumber,
            timeCheck,
            crlUrl,
            crlBase64
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    CheckCRLBase64: function (certBase64, timeCheck, crlUrl, crlBase64, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.CheckCRLBase64;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            certBase64,
            timeCheck,
            crlUrl,
            crlBase64
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    CheckToken: function (funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.CheckToken;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            ""
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    checkPlugin: function (funcCallback) {
        vnptCheckPluginCallback = funcCallback;

        checkPluginCall = 1;
        timeOut = 3000;

        var callInfo = {};
        callInfo.functionID = functionId.checkPlugin;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            ""
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    checkPluginAdvanced: function (funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.checkPluginAdvanced;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        pluginSignal = GenerateSignal();
        var args = [
            pluginSignal
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    getVersion: function (funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.getVersion;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            ""
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    Scan: function (iSaveFile, funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.Scan;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var saveFileScanned = 0;
        if (iSaveFile != undefined && iSaveFile != null && iSaveFile) {
            saveFileScanned = 1;
        }
        var args = [
            saveFileScanned
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    GetDataScanned: function (path, funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.GetDataScanned;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            path
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    OpenDocument: function (data, name, type, options, funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.OpenDocument;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }

        var args = [
            data,
            name,
            type,
            options
        ];

        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    ConvertOfficeToPdf: function (data, type, funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.ConvertOfficeToPdf;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }

        var args = [
            data,                        
            type
        ];

        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    BatchScan: function (options, funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.BatchScan;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var scanner = new Scanner();
        scanner.options = options;
        var pramaters = JSON.stringify(scanner);

        var args = [
            pramaters
        ];

        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    HandleFile: function (funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.HandleFile;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }

        var args = [
            ""
        ];

        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    DeleteFile: function (path, funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.DeleteFile;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }

        var args = [
            path
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    SetIgnoreListFiles: function (list, funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.SetIgnoreListFiles;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }

        var args = [
            list
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    GetAllFiles: function (directory, funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.GetAllFiles;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            directory
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    GetFilePreview: function (path, pageStart, pageEnd, funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.GetFilePreview;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            path,
            pageStart,
            pageEnd
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    UploadFile: function (uplink, path, options, funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.UploadFile;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var scanner = new Scanner();
        var cookie = getCookie[uplink];
        scanner.cookie = cookie;
        scanner.options = options;
        scanner.uplink = uplink;
        scanner.path = path;
        var pramaters = JSON.stringify(scanner);

        var args = [
            pramaters
        ];

        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    checkBrowser: function () {
        var browser = get_browser();
        switch (browser.name.toLowerCase()) {
            case "chrome":
                if (browser.version > 52) {
                    return true;
                }
            case "firefox":
                if (browser.version > 49) {
                    return true;
                }
            case "opera":
                if (browser.version > 26) {
                    return true;
                }
            case "edge":
                if (browser.version > 15) {
                    return true;
                }
            case "ie":
                if (browser.version > 6) {
                    return true;
                }
            case "msie":
                if (browser.version > 6) {
                    return true;
                }
            case "safari":
                if (browser.version > 10) {
                    return true;
                }
            default:
                console.log("Browser not supported yet");
                return false;
        }
    },
    checkBrowserSupportWS: function () {
        var browser = get_browser();
        switch (browser.name.toLowerCase()) {
            case "chrome":
                if (browser.version > 52) {
                    return true;
                }
            case "firefox":
                if (browser.version > 49) {
                    return true;
                }
            case "opera":
                if (browser.version > 26) {
                    return true;
                }
            case "edge":
                if (browser.version > 15) {
                    return true;
                }
            case "ie":
                return false;
            case "msie":
                return false;
            case "safari":
                if (browser.version > 10) {
                    return true;
                }
            default:
                console.log("Browser not supported yet");
                return false;
        }
    },
    getOsName: function () {
        return getOsName();
    },
    GetComputerInfo: function (funcCallback) {
        vnptCheckPluginCallback = funcCallback;
        var callInfo = {};
        callInfo.functionID = functionId.GetComputerInfo;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            ""
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
    ClearPinCache: function (times, funcCallback) {
        var callInfo = {};
        callInfo.functionID = functionId.ClearPinCache;
        if (funcCallback != null) {
            if ((navigator.userAgent.indexOf("MSIE") != -1) || (!!document.documentMode == true))
                callInfo.funcCallback = funcCallback.toString().match(/^function\s*([^\s(]+)/)[1];
            else
                callInfo.funcCallback = funcCallback.name;
        }
        else {
            callInfo.funcCallback = "callbackDefault";
        }
        var args = [
            times
        ];
        callInfo.args = args;
        return this.sendMessageToPlugin(callInfo);
    },
}
// get all cookie
function getCookie(uplink) {

    var cookies = {};

    if (document.cookie && document.cookie != '') {
        var split = document.cookie.split(';');
        for (var i = 0; i < split.length; i++) {
            var name_value = split[i].split("=");
            name_value[0] = name_value[0].replace(/^ /, '');
            cookies[decodeURIComponent(name_value[0])] = decodeURIComponent(name_value[1]);
        }
    }

    return cookies[uplink];

}
function setCookie(name, value, days) {
    var expires = "";
    if (days) {
        var date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (value || "") + expires + "; path=/";
}
//
function Scanner() {
    this.cookie = null;
    this.options = null;
    this.uplink = null;
    this.downlink = null;
    this.path = null;

}
function PdfSigner() {
    this.page = 1;
    this.llx = 0;
    this.lly = 0;
    this.urx = 150;
    this.ury = 75;
    this.SigTextSize = 9;
    this.Signer = null;
    this.SignerPosition = null;
    this.SigningTime = null; // HH:mm:ss dd/MM/yyyy
    this.Description = null;
    this.ImageBase64 = null;
    this.OnlyDescription = false;
    this.ValidationOption = true;
    this.SigColorRGB = null;
    this.SetImageBackground = false;
    this.PagesArray = null;
    this.CertificateSerial = null;
    this.TsaUrl = null;
    this.TsaUsername = null;
    this.TsaPassword = null;
    this.AdvancedCustom = false; // show form custom if set true
    this.SigType = 0;			 // Kieu ky: 0 - ky chi mo ta, 1 - mo ta + ten, 2 - mo ta + anh, chi anh
    this.IsEncyptFile = false;   // Ma hoa file hay khong
    this.EncryptPassword = null; // MK ma hoa
    this.SigVisible = true; 	 // Hien thi chu ky hay k?
    this.SigSignerVisible = true;// Hien thi nguoi ky
    this.SigEmailVisible = true; // Hien thi chu ky hay k?
    this.SigPositionVisible = false;// Hien thi chu ky hay k?
    this.SigSigningTimeVisible = true; // Hien thi chu ky hay k?    
}
// Features has not support yet
function XmlSigner() {
    this.TagSigning = null;
    this.NodeToSign = null;
    this.TagSaveResult = null;
    this.ParrentTagSigning = null;
    this.NameXPathFilter = null;
    this.NameIDTimeSignature = null;
    this.DsSignature = false;
    this.SigningType = "Enveloped";
    this.SigningTime = null; // HH:mm:ss dd/MM/yyyy
    this.CertificateSerial = null;
    this.ValidateBefore = false;
    this.DigestMethod = "SHA1"; //OR SHA256
    this.SignatureMethod = "RSAwithSHA1"; //OR RSAwithSHA256
}
function GenerateSignal() {
    var text = "";
    var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (var i = 0; i < 5; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
/************************************************************************/
/* jsbn.js                                                              */
/************************************************************************/
/*
 * Copyright (c) 2003-2005  Tom Wu
 * All Rights Reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS-IS" AND WITHOUT WARRANTY OF ANY KIND, 
 * EXPRESS, IMPLIED OR OTHERWISE, INCLUDING WITHOUT LIMITATION, ANY 
 * WARRANTY OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.  
 *
 * IN NO EVENT SHALL TOM WU BE LIABLE FOR ANY SPECIAL, INCIDENTAL,
 * INDIRECT OR CONSEQUENTIAL DAMAGES OF ANY KIND, OR ANY DAMAGES WHATSOEVER
 * RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER OR NOT ADVISED OF
 * THE POSSIBILITY OF DAMAGE, AND ON ANY THEORY OF LIABILITY, ARISING OUT
 * OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * In addition, the following condition applies:
 *
 * All redistributions must retain an intact copy of this copyright notice
 * and disclaimer.
 */

// Basic JavaScript BN library - subset useful for RSA encryption.

/************************************************************************/
/* jsbn.js                                                              */
/************************************************************************/

// Bits per digit
var dbits;
// JavaScript engine analysis
var canary = 0xdeadbeefcafe;
var j_lm = ((canary & 0xffffff) == 0xefcafe);

// (public) Constructor
function BigInteger(a, b, c) {
    if (a != null)
        if ("number" == typeof a) this.fromNumber(a, b, c);
        else if (b == null && "string" != typeof a) this.fromString(a, 256);
        else this.fromString(a, b);
}

// return new, unset BigInteger
function nbi() { return new BigInteger(null); }

// am: Compute w_j += (x*this_i), propagate carries,
// c is initial carry, returns final carry.
// c < 3*dvalue, x < 2*dvalue, this_i < dvalue
// We need to select the fastest one that works in this environment.

// am1: use a single mult and divide to get the high bits,
// max digit bits should be 26 because
// max internal value = 2*dvalue^2-2*dvalue (< 2^53)
function am1(i, x, w, j, c, n) {
    while (--n >= 0) {
        var v = x * this[i++] + w[j] + c;
        c = Math.floor(v / 0x4000000);
        w[j++] = v & 0x3ffffff;
    }
    return c;
}
// am2 avoids a big mult-and-extract completely.
// Max digit bits should be <= 30 because we do bitwise ops
// on values up to 2*hdvalue^2-hdvalue-1 (< 2^31)
function am2(i, x, w, j, c, n) {
    var xl = x & 0x7fff, xh = x >> 15;
    while (--n >= 0) {
        var l = this[i] & 0x7fff;
        var h = this[i++] >> 15;
        var m = xh * l + h * xl;
        l = xl * l + ((m & 0x7fff) << 15) + w[j] + (c & 0x3fffffff);
        c = (l >>> 30) + (m >>> 15) + xh * h + (c >>> 30);
        w[j++] = l & 0x3fffffff;
    }
    return c;
}
// Alternately, set max digit bits to 28 since some
// browsers slow down when dealing with 32-bit numbers.
function am3(i, x, w, j, c, n) {
    var xl = x & 0x3fff, xh = x >> 14;
    while (--n >= 0) {
        var l = this[i] & 0x3fff;
        var h = this[i++] >> 14;
        var m = xh * l + h * xl;
        l = xl * l + ((m & 0x3fff) << 14) + w[j] + c;
        c = (l >> 28) + (m >> 14) + xh * h;
        w[j++] = l & 0xfffffff;
    }
    return c;
}
if (j_lm && (navigator.appName == "Microsoft Internet Explorer")) {
    BigInteger.prototype.am = am2;
    dbits = 30;
}
else if (j_lm && (navigator.appName != "Netscape")) {
    BigInteger.prototype.am = am1;
    dbits = 26;
}
else { // Mozilla/Netscape seems to prefer am3
    BigInteger.prototype.am = am3;
    dbits = 28;
}

BigInteger.prototype.DB = dbits;
BigInteger.prototype.DM = ((1 << dbits) - 1);
BigInteger.prototype.DV = (1 << dbits);

var BI_FP = 52;
BigInteger.prototype.FV = Math.pow(2, BI_FP);
BigInteger.prototype.F1 = BI_FP - dbits;
BigInteger.prototype.F2 = 2 * dbits - BI_FP;

// Digit conversions
var BI_RM = "0123456789abcdefghijklmnopqrstuvwxyz";
var BI_RC = new Array();
var rr, vv;
rr = "0".charCodeAt(0);
for (vv = 0; vv <= 9; ++vv) BI_RC[rr++] = vv;
rr = "a".charCodeAt(0);
for (vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;
rr = "A".charCodeAt(0);
for (vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;

function int2char(n) { return BI_RM.charAt(n); }
function intAt(s, i) {
    var c = BI_RC[s.charCodeAt(i)];
    return (c == null) ? -1 : c;
}

// (protected) copy this to r
function bnpCopyTo(r) {
    for (var i = this.t - 1; i >= 0; --i) r[i] = this[i];
    r.t = this.t;
    r.s = this.s;
}

// (protected) set from integer value x, -DV <= x < DV
function bnpFromInt(x) {
    this.t = 1;
    this.s = (x < 0) ? -1 : 0;
    if (x > 0) this[0] = x;
    else if (x < -1) this[0] = x + DV;
    else this.t = 0;
}

// return bigint initialized to value
function nbv(i) { var r = nbi(); r.fromInt(i); return r; }

// (protected) set from string and radix
function bnpFromString(s, b) {
    var k;
    if (b == 16) k = 4;
    else if (b == 8) k = 3;
    else if (b == 256) k = 8; // byte array
    else if (b == 2) k = 1;
    else if (b == 32) k = 5;
    else if (b == 4) k = 2;
    else { this.fromRadix(s, b); return; }
    this.t = 0;
    this.s = 0;
    var i = s.length, mi = false, sh = 0;
    while (--i >= 0) {
        var x = (k == 8) ? s[i] & 0xff : intAt(s, i);
        if (x < 0) {
            if (s.charAt(i) == "-") mi = true;
            continue;
        }
        mi = false;
        if (sh == 0)
            this[this.t++] = x;
        else if (sh + k > this.DB) {
            this[this.t - 1] |= (x & ((1 << (this.DB - sh)) - 1)) << sh;
            this[this.t++] = (x >> (this.DB - sh));
        }
        else
            this[this.t - 1] |= x << sh;
        sh += k;
        if (sh >= this.DB) sh -= this.DB;
    }
    if (k == 8 && (s[0] & 0x80) != 0) {
        this.s = -1;
        if (sh > 0) this[this.t - 1] |= ((1 << (this.DB - sh)) - 1) << sh;
    }
    this.clamp();
    if (mi) BigInteger.ZERO.subTo(this, this);
}

// (protected) clamp off excess high words
function bnpClamp() {
    var c = this.s & this.DM;
    while (this.t > 0 && this[this.t - 1] == c)--this.t;
}

// (public) return string representation in given radix
function bnToString(b) {
    if (this.s < 0) return "-" + this.negate().toString(b);
    var k;
    if (b == 16) k = 4;
    else if (b == 8) k = 3;
    else if (b == 2) k = 1;
    else if (b == 32) k = 5;
    else if (b == 4) k = 2;
    else return this.toRadix(b);
    var km = (1 << k) - 1, d, m = false, r = "", i = this.t;
    var p = this.DB - (i * this.DB) % k;
    if (i-- > 0) {
        if (p < this.DB && (d = this[i] >> p) > 0) { m = true; r = int2char(d); }
        while (i >= 0) {
            if (p < k) {
                d = (this[i] & ((1 << p) - 1)) << (k - p);
                d |= this[--i] >> (p += this.DB - k);
            }
            else {
                d = (this[i] >> (p -= k)) & km;
                if (p <= 0) { p += this.DB; --i; }
            }
            if (d > 0) m = true;
            if (m) r += int2char(d);
        }
    }
    return m ? r : "0";
}

// (public) -this
function bnNegate() { var r = nbi(); BigInteger.ZERO.subTo(this, r); return r; }

// (public) |this|
function bnAbs() { return (this.s < 0) ? this.negate() : this; }

// (public) return + if this > a, - if this < a, 0 if equal
function bnCompareTo(a) {
    var r = this.s - a.s;
    if (r != 0) return r;
    var i = this.t;
    r = i - a.t;
    if (r != 0) return r;
    while (--i >= 0) if ((r = this[i] - a[i]) != 0) return r;
    return 0;
}

// returns bit length of the integer x
function nbits(x) {
    var r = 1, t;
    if ((t = x >>> 16) != 0) { x = t; r += 16; }
    if ((t = x >> 8) != 0) { x = t; r += 8; }
    if ((t = x >> 4) != 0) { x = t; r += 4; }
    if ((t = x >> 2) != 0) { x = t; r += 2; }
    if ((t = x >> 1) != 0) { x = t; r += 1; }
    return r;
}

// (public) return the number of bits in "this"
function bnBitLength() {
    if (this.t <= 0) return 0;
    return this.DB * (this.t - 1) + nbits(this[this.t - 1] ^ (this.s & this.DM));
}

// (protected) r = this << n*DB
function bnpDLShiftTo(n, r) {
    var i;
    for (i = this.t - 1; i >= 0; --i) r[i + n] = this[i];
    for (i = n - 1; i >= 0; --i) r[i] = 0;
    r.t = this.t + n;
    r.s = this.s;
}

// (protected) r = this >> n*DB
function bnpDRShiftTo(n, r) {
    for (var i = n; i < this.t; ++i) r[i - n] = this[i];
    r.t = Math.max(this.t - n, 0);
    r.s = this.s;
}

// (protected) r = this << n
function bnpLShiftTo(n, r) {
    var bs = n % this.DB;
    var cbs = this.DB - bs;
    var bm = (1 << cbs) - 1;
    var ds = Math.floor(n / this.DB), c = (this.s << bs) & this.DM, i;
    for (i = this.t - 1; i >= 0; --i) {
        r[i + ds + 1] = (this[i] >> cbs) | c;
        c = (this[i] & bm) << bs;
    }
    for (i = ds - 1; i >= 0; --i) r[i] = 0;
    r[ds] = c;
    r.t = this.t + ds + 1;
    r.s = this.s;
    r.clamp();
}

// (protected) r = this >> n
function bnpRShiftTo(n, r) {
    r.s = this.s;
    var ds = Math.floor(n / this.DB);
    if (ds >= this.t) { r.t = 0; return; }
    var bs = n % this.DB;
    var cbs = this.DB - bs;
    var bm = (1 << bs) - 1;
    r[0] = this[ds] >> bs;
    for (var i = ds + 1; i < this.t; ++i) {
        r[i - ds - 1] |= (this[i] & bm) << cbs;
        r[i - ds] = this[i] >> bs;
    }
    if (bs > 0) r[this.t - ds - 1] |= (this.s & bm) << cbs;
    r.t = this.t - ds;
    r.clamp();
}

// (protected) r = this - a
function bnpSubTo(a, r) {
    var i = 0, c = 0, m = Math.min(a.t, this.t);
    while (i < m) {
        c += this[i] - a[i];
        r[i++] = c & this.DM;
        c >>= this.DB;
    }
    if (a.t < this.t) {
        c -= a.s;
        while (i < this.t) {
            c += this[i];
            r[i++] = c & this.DM;
            c >>= this.DB;
        }
        c += this.s;
    }
    else {
        c += this.s;
        while (i < a.t) {
            c -= a[i];
            r[i++] = c & this.DM;
            c >>= this.DB;
        }
        c -= a.s;
    }
    r.s = (c < 0) ? -1 : 0;
    if (c < -1) r[i++] = this.DV + c;
    else if (c > 0) r[i++] = c;
    r.t = i;
    r.clamp();
}

// (protected) r = this * a, r != this,a (HAC 14.12)
// "this" should be the larger one if appropriate.
function bnpMultiplyTo(a, r) {
    var x = this.abs(), y = a.abs();
    var i = x.t;
    r.t = i + y.t;
    while (--i >= 0) r[i] = 0;
    for (i = 0; i < y.t; ++i) r[i + x.t] = x.am(0, y[i], r, i, 0, x.t);
    r.s = 0;
    r.clamp();
    if (this.s != a.s) BigInteger.ZERO.subTo(r, r);
}

// (protected) r = this^2, r != this (HAC 14.16)
function bnpSquareTo(r) {
    var x = this.abs();
    var i = r.t = 2 * x.t;
    while (--i >= 0) r[i] = 0;
    for (i = 0; i < x.t - 1; ++i) {
        var c = x.am(i, x[i], r, 2 * i, 0, 1);
        if ((r[i + x.t] += x.am(i + 1, 2 * x[i], r, 2 * i + 1, c, x.t - i - 1)) >= x.DV) {
            r[i + x.t] -= x.DV;
            r[i + x.t + 1] = 1;
        }
    }
    if (r.t > 0) r[r.t - 1] += x.am(i, x[i], r, 2 * i, 0, 1);
    r.s = 0;
    r.clamp();
}

// (protected) divide this by m, quotient and remainder to q, r (HAC 14.20)
// r != q, this != m.  q or r may be null.
function bnpDivRemTo(m, q, r) {
    var pm = m.abs();
    if (pm.t <= 0) return;
    var pt = this.abs();
    if (pt.t < pm.t) {
        if (q != null) q.fromInt(0);
        if (r != null) this.copyTo(r);
        return;
    }
    if (r == null) r = nbi();
    var y = nbi(), ts = this.s, ms = m.s;
    var nsh = this.DB - nbits(pm[pm.t - 1]); // normalize modulus
    if (nsh > 0) { pm.lShiftTo(nsh, y); pt.lShiftTo(nsh, r); }
    else { pm.copyTo(y); pt.copyTo(r); }
    var ys = y.t;
    var y0 = y[ys - 1];
    if (y0 == 0) return;
    var yt = y0 * (1 << this.F1) + ((ys > 1) ? y[ys - 2] >> this.F2 : 0);
    var d1 = this.FV / yt, d2 = (1 << this.F1) / yt, e = 1 << this.F2;
    var i = r.t, j = i - ys, t = (q == null) ? nbi() : q;
    y.dlShiftTo(j, t);
    if (r.compareTo(t) >= 0) {
        r[r.t++] = 1;
        r.subTo(t, r);
    }
    BigInteger.ONE.dlShiftTo(ys, t);
    t.subTo(y, y); // "negative" y so we can replace sub with am later
    while (y.t < ys) y[y.t++] = 0;
    while (--j >= 0) {
        // Estimate quotient digit
        var qd = (r[--i] == y0) ? this.DM : Math.floor(r[i] * d1 + (r[i - 1] + e) * d2);
        if ((r[i] += y.am(0, qd, r, j, 0, ys)) < qd) {	// Try it out
            y.dlShiftTo(j, t);
            r.subTo(t, r);
            while (r[i] < --qd) r.subTo(t, r);
        }
    }
    if (q != null) {
        r.drShiftTo(ys, q);
        if (ts != ms) BigInteger.ZERO.subTo(q, q);
    }
    r.t = ys;
    r.clamp();
    if (nsh > 0) r.rShiftTo(nsh, r); // Denormalize remainder
    if (ts < 0) BigInteger.ZERO.subTo(r, r);
}

// (public) this mod a
function bnMod(a) {
    var r = nbi();
    this.abs().divRemTo(a, null, r);
    if (this.s < 0 && r.compareTo(BigInteger.ZERO) > 0) a.subTo(r, r);
    return r;
}

// Modular reduction using "classic" algorithm
function Classic(m) { this.m = m; }
function cConvert(x) {
    if (x.s < 0 || x.compareTo(this.m) >= 0) return x.mod(this.m);
    else return x;
}
function cRevert(x) { return x; }
function cReduce(x) { x.divRemTo(this.m, null, x); }
function cMulTo(x, y, r) { x.multiplyTo(y, r); this.reduce(r); }
function cSqrTo(x, r) { x.squareTo(r); this.reduce(r); }

Classic.prototype.convert = cConvert;
Classic.prototype.revert = cRevert;
Classic.prototype.reduce = cReduce;
Classic.prototype.mulTo = cMulTo;
Classic.prototype.sqrTo = cSqrTo;

// (protected) return "-1/this % 2^DB"; useful for Mont. reduction
// justification:
//         xy == 1 (mod m)
//         xy =  1+km
//   xy(2-xy) = (1+km)(1-km)
// x[y(2-xy)] = 1-k^2m^2
// x[y(2-xy)] == 1 (mod m^2)
// if y is 1/x mod m, then y(2-xy) is 1/x mod m^2
// should reduce x and y(2-xy) by m^2 at each step to keep size bounded.
// JS multiply "overflows" differently from C/C++, so care is needed here.
function bnpInvDigit() {
    if (this.t < 1) return 0;
    var x = this[0];
    if ((x & 1) == 0) return 0;
    var y = x & 3; 	// y == 1/x mod 2^2
    y = (y * (2 - (x & 0xf) * y)) & 0xf; // y == 1/x mod 2^4
    y = (y * (2 - (x & 0xff) * y)) & 0xff; // y == 1/x mod 2^8
    y = (y * (2 - (((x & 0xffff) * y) & 0xffff))) & 0xffff; // y == 1/x mod 2^16
    // last step - calculate inverse mod DV directly;
    // assumes 16 < DB <= 32 and assumes ability to handle 48-bit ints
    y = (y * (2 - x * y % this.DV)) % this.DV; 	// y == 1/x mod 2^dbits
    // we really want the negative inverse, and -DV < y < DV
    return (y > 0) ? this.DV - y : -y;
}

// Montgomery reduction
function Montgomery(m) {
    this.m = m;
    this.mp = m.invDigit();
    this.mpl = this.mp & 0x7fff;
    this.mph = this.mp >> 15;
    this.um = (1 << (m.DB - 15)) - 1;
    this.mt2 = 2 * m.t;
}

// xR mod m
function montConvert(x) {
    var r = nbi();
    x.abs().dlShiftTo(this.m.t, r);
    r.divRemTo(this.m, null, r);
    if (x.s < 0 && r.compareTo(BigInteger.ZERO) > 0) this.m.subTo(r, r);
    return r;
}

// x/R mod m
function montRevert(x) {
    var r = nbi();
    x.copyTo(r);
    this.reduce(r);
    return r;
}

// x = x/R mod m (HAC 14.32)
function montReduce(x) {
    while (x.t <= this.mt2)	// pad x so am has enough room later
        x[x.t++] = 0;
    for (var i = 0; i < this.m.t; ++i) {
        // faster way of calculating u0 = x[i]*mp mod DV
        var j = x[i] & 0x7fff;
        var u0 = (j * this.mpl + (((j * this.mph + (x[i] >> 15) * this.mpl) & this.um) << 15)) & x.DM;
        // use am to combine the multiply-shift-add into one call
        j = i + this.m.t;
        x[j] += this.m.am(0, u0, x, i, 0, this.m.t);
        // propagate carry
        while (x[j] >= x.DV) { x[j] -= x.DV; x[++j]++; }
    }
    x.clamp();
    x.drShiftTo(this.m.t, x);
    if (x.compareTo(this.m) >= 0) x.subTo(this.m, x);
}

// r = "x^2/R mod m"; x != r
function montSqrTo(x, r) { x.squareTo(r); this.reduce(r); }

// r = "xy/R mod m"; x,y != r
function montMulTo(x, y, r) { x.multiplyTo(y, r); this.reduce(r); }

Montgomery.prototype.convert = montConvert;
Montgomery.prototype.revert = montRevert;
Montgomery.prototype.reduce = montReduce;
Montgomery.prototype.mulTo = montMulTo;
Montgomery.prototype.sqrTo = montSqrTo;

// (protected) true iff this is even
function bnpIsEven() { return ((this.t > 0) ? (this[0] & 1) : this.s) == 0; }

// (protected) this^e, e < 2^32, doing sqr and mul with "r" (HAC 14.79)
function bnpExp(e, z) {
    if (e > 0xffffffff || e < 1) return BigInteger.ONE;
    var r = nbi(), r2 = nbi(), g = z.convert(this), i = nbits(e) - 1;
    g.copyTo(r);
    while (--i >= 0) {
        z.sqrTo(r, r2);
        if ((e & (1 << i)) > 0) z.mulTo(r2, g, r);
        else { var t = r; r = r2; r2 = t; }
    }
    return z.revert(r);
}

// (public) this^e % m, 0 <= e < 2^32
function bnModPowInt(e, m) {
    var z;
    if (e < 256 || m.isEven()) z = new Classic(m); else z = new Montgomery(m);
    return this.exp(e, z);
}

// protected
BigInteger.prototype.copyTo = bnpCopyTo;
BigInteger.prototype.fromInt = bnpFromInt;
BigInteger.prototype.fromString = bnpFromString;
BigInteger.prototype.clamp = bnpClamp;
BigInteger.prototype.dlShiftTo = bnpDLShiftTo;
BigInteger.prototype.drShiftTo = bnpDRShiftTo;
BigInteger.prototype.lShiftTo = bnpLShiftTo;
BigInteger.prototype.rShiftTo = bnpRShiftTo;
BigInteger.prototype.subTo = bnpSubTo;
BigInteger.prototype.multiplyTo = bnpMultiplyTo;
BigInteger.prototype.squareTo = bnpSquareTo;
BigInteger.prototype.divRemTo = bnpDivRemTo;
BigInteger.prototype.invDigit = bnpInvDigit;
BigInteger.prototype.isEven = bnpIsEven;
BigInteger.prototype.exp = bnpExp;

// public
BigInteger.prototype.toString = bnToString;
BigInteger.prototype.negate = bnNegate;
BigInteger.prototype.abs = bnAbs;
BigInteger.prototype.compareTo = bnCompareTo;
BigInteger.prototype.bitLength = bnBitLength;
BigInteger.prototype.mod = bnMod;
BigInteger.prototype.modPowInt = bnModPowInt;

// "constants"
BigInteger.ZERO = nbv(0);
BigInteger.ONE = nbv(1);

/************************************************************************/
/* JSBN2                                                                */
/************************************************************************/
// Copyright (c) 2005-2009  Tom Wu
// All Rights Reserved.
// See "LICENSE" for details.

// Extended JavaScript BN functions, required for RSA private ops.

// Version 1.1: new BigInteger("0", 10) returns "proper" zero

// (public)
function bnClone() { var r = nbi(); this.copyTo(r); return r; }

// (public) return value as integer
function bnIntValue() {
    if (this.s < 0) {
        if (this.t == 1) return this[0] - this.DV;
        else if (this.t == 0) return -1;
    }
    else if (this.t == 1) return this[0];
    else if (this.t == 0) return 0;
    // assumes 16 < DB < 32
    return ((this[1] & ((1 << (32 - this.DB)) - 1)) << this.DB) | this[0];
}

// (public) return value as byte
function bnByteValue() { return (this.t == 0) ? this.s : (this[0] << 24) >> 24; }

// (public) return value as short (assumes DB>=16)
function bnShortValue() { return (this.t == 0) ? this.s : (this[0] << 16) >> 16; }

// (protected) return x s.t. r^x < DV
function bnpChunkSize(r) { return Math.floor(Math.LN2 * this.DB / Math.log(r)); }

// (public) 0 if this == 0, 1 if this > 0
function bnSigNum() {
    if (this.s < 0) return -1;
    else if (this.t <= 0 || (this.t == 1 && this[0] <= 0)) return 0;
    else return 1;
}

// (protected) convert to radix string
function bnpToRadix(b) {
    if (b == null) b = 10;
    if (this.signum() == 0 || b < 2 || b > 36) return "0";
    var cs = this.chunkSize(b);
    var a = Math.pow(b, cs);
    var d = nbv(a), y = nbi(), z = nbi(), r = "";
    this.divRemTo(d, y, z);
    while (y.signum() > 0) {
        r = (a + z.intValue()).toString(b).substr(1) + r;
        y.divRemTo(d, y, z);
    }
    return z.intValue().toString(b) + r;
}

// (protected) convert from radix string
function bnpFromRadix(s, b) {
    this.fromInt(0);
    if (b == null) b = 10;
    var cs = this.chunkSize(b);
    var d = Math.pow(b, cs), mi = false, j = 0, w = 0;
    for (var i = 0; i < s.length; ++i) {
        var x = intAt(s, i);
        if (x < 0) {
            if (s.charAt(i) == "-" && this.signum() == 0) mi = true;
            continue;
        }
        w = b * w + x;
        if (++j >= cs) {
            this.dMultiply(d);
            this.dAddOffset(w, 0);
            j = 0;
            w = 0;
        }
    }
    if (j > 0) {
        this.dMultiply(Math.pow(b, j));
        this.dAddOffset(w, 0);
    }
    if (mi) BigInteger.ZERO.subTo(this, this);
}

// (protected) alternate constructor
function bnpFromNumber(a, b, c) {
    if ("number" == typeof b) {
        // new BigInteger(int,int,RNG)
        if (a < 2) this.fromInt(1);
        else {
            this.fromNumber(a, c);
            if (!this.testBit(a - 1))	// force MSB set
                this.bitwiseTo(BigInteger.ONE.shiftLeft(a - 1), op_or, this);
            if (this.isEven()) this.dAddOffset(1, 0); // force odd
            while (!this.isProbablePrime(b)) {
                this.dAddOffset(2, 0);
                if (this.bitLength() > a) this.subTo(BigInteger.ONE.shiftLeft(a - 1), this);
            }
        }
    }
    else {
        // new BigInteger(int,RNG)
        var x = new Array(), t = a & 7;
        x.length = (a >> 3) + 1;
        b.nextBytes(x);
        if (t > 0) x[0] &= ((1 << t) - 1); else x[0] = 0;
        this.fromString(x, 256);
    }
}

// (public) convert to bigendian byte array
function bnToByteArray() {
    var i = this.t, r = new Array();
    r[0] = this.s;
    var p = this.DB - (i * this.DB) % 8, d, k = 0;
    if (i-- > 0) {
        if (p < this.DB && (d = this[i] >> p) != (this.s & this.DM) >> p)
            r[k++] = d | (this.s << (this.DB - p));
        while (i >= 0) {
            if (p < 8) {
                d = (this[i] & ((1 << p) - 1)) << (8 - p);
                d |= this[--i] >> (p += this.DB - 8);
            }
            else {
                d = (this[i] >> (p -= 8)) & 0xff;
                if (p <= 0) { p += this.DB; --i; }
            }
            if ((d & 0x80) != 0) d |= -256;
            if (k == 0 && (this.s & 0x80) != (d & 0x80))++k;
            if (k > 0 || d != this.s) r[k++] = d;
        }
    }
    return r;
}

function bnEquals(a) { return (this.compareTo(a) == 0); }
function bnMin(a) { return (this.compareTo(a) < 0) ? this : a; }
function bnMax(a) { return (this.compareTo(a) > 0) ? this : a; }

// (protected) r = this op a (bitwise)
function bnpBitwiseTo(a, op, r) {
    var i, f, m = Math.min(a.t, this.t);
    for (i = 0; i < m; ++i) r[i] = op(this[i], a[i]);
    if (a.t < this.t) {
        f = a.s & this.DM;
        for (i = m; i < this.t; ++i) r[i] = op(this[i], f);
        r.t = this.t;
    }
    else {
        f = this.s & this.DM;
        for (i = m; i < a.t; ++i) r[i] = op(f, a[i]);
        r.t = a.t;
    }
    r.s = op(this.s, a.s);
    r.clamp();
}

// (public) this & a
function op_and(x, y) { return x & y; }
function bnAnd(a) { var r = nbi(); this.bitwiseTo(a, op_and, r); return r; }

// (public) this | a
function op_or(x, y) { return x | y; }
function bnOr(a) { var r = nbi(); this.bitwiseTo(a, op_or, r); return r; }

// (public) this ^ a
function op_xor(x, y) { return x ^ y; }
function bnXor(a) { var r = nbi(); this.bitwiseTo(a, op_xor, r); return r; }

// (public) this & ~a
function op_andnot(x, y) { return x & ~y; }
function bnAndNot(a) { var r = nbi(); this.bitwiseTo(a, op_andnot, r); return r; }

// (public) ~this
function bnNot() {
    var r = nbi();
    for (var i = 0; i < this.t; ++i) r[i] = this.DM & ~this[i];
    r.t = this.t;
    r.s = ~this.s;
    return r;
}

// (public) this << n
function bnShiftLeft(n) {
    var r = nbi();
    if (n < 0) this.rShiftTo(-n, r); else this.lShiftTo(n, r);
    return r;
}

// (public) this >> n
function bnShiftRight(n) {
    var r = nbi();
    if (n < 0) this.lShiftTo(-n, r); else this.rShiftTo(n, r);
    return r;
}

// return index of lowest 1-bit in x, x < 2^31
function lbit(x) {
    if (x == 0) return -1;
    var r = 0;
    if ((x & 0xffff) == 0) { x >>= 16; r += 16; }
    if ((x & 0xff) == 0) { x >>= 8; r += 8; }
    if ((x & 0xf) == 0) { x >>= 4; r += 4; }
    if ((x & 3) == 0) { x >>= 2; r += 2; }
    if ((x & 1) == 0)++r;
    return r;
}

// (public) returns index of lowest 1-bit (or -1 if none)
function bnGetLowestSetBit() {
    for (var i = 0; i < this.t; ++i)
        if (this[i] != 0) return i * this.DB + lbit(this[i]);
    if (this.s < 0) return this.t * this.DB;
    return -1;
}

// return number of 1 bits in x
function cbit(x) {
    var r = 0;
    while (x != 0) { x &= x - 1; ++r; }
    return r;
}

// (public) return number of set bits
function bnBitCount() {
    var r = 0, x = this.s & this.DM;
    for (var i = 0; i < this.t; ++i) r += cbit(this[i] ^ x);
    return r;
}

// (public) true iff nth bit is set
function bnTestBit(n) {
    var j = Math.floor(n / this.DB);
    if (j >= this.t) return (this.s != 0);
    return ((this[j] & (1 << (n % this.DB))) != 0);
}

// (protected) this op (1<<n)
function bnpChangeBit(n, op) {
    var r = BigInteger.ONE.shiftLeft(n);
    this.bitwiseTo(r, op, r);
    return r;
}

// (public) this | (1<<n)
function bnSetBit(n) { return this.changeBit(n, op_or); }

// (public) this & ~(1<<n)
function bnClearBit(n) { return this.changeBit(n, op_andnot); }

// (public) this ^ (1<<n)
function bnFlipBit(n) { return this.changeBit(n, op_xor); }

// (protected) r = this + a
function bnpAddTo(a, r) {
    var i = 0, c = 0, m = Math.min(a.t, this.t);
    while (i < m) {
        c += this[i] + a[i];
        r[i++] = c & this.DM;
        c >>= this.DB;
    }
    if (a.t < this.t) {
        c += a.s;
        while (i < this.t) {
            c += this[i];
            r[i++] = c & this.DM;
            c >>= this.DB;
        }
        c += this.s;
    }
    else {
        c += this.s;
        while (i < a.t) {
            c += a[i];
            r[i++] = c & this.DM;
            c >>= this.DB;
        }
        c += a.s;
    }
    r.s = (c < 0) ? -1 : 0;
    if (c > 0) r[i++] = c;
    else if (c < -1) r[i++] = this.DV + c;
    r.t = i;
    r.clamp();
}

// (public) this + a
function bnAdd(a) { var r = nbi(); this.addTo(a, r); return r; }

// (public) this - a
function bnSubtract(a) { var r = nbi(); this.subTo(a, r); return r; }

// (public) this * a
function bnMultiply(a) { var r = nbi(); this.multiplyTo(a, r); return r; }

// (public) this / a
function bnDivide(a) { var r = nbi(); this.divRemTo(a, r, null); return r; }

// (public) this % a
function bnRemainder(a) { var r = nbi(); this.divRemTo(a, null, r); return r; }

// (public) [this/a,this%a]
function bnDivideAndRemainder(a) {
    var q = nbi(), r = nbi();
    this.divRemTo(a, q, r);
    return new Array(q, r);
}

// (protected) this *= n, this >= 0, 1 < n < DV
function bnpDMultiply(n) {
    this[this.t] = this.am(0, n - 1, this, 0, 0, this.t);
    ++this.t;
    this.clamp();
}

// (protected) this += n << w words, this >= 0
function bnpDAddOffset(n, w) {
    if (n == 0) return;
    while (this.t <= w) this[this.t++] = 0;
    this[w] += n;
    while (this[w] >= this.DV) {
        this[w] -= this.DV;
        if (++w >= this.t) this[this.t++] = 0;
        ++this[w];
    }
}

// A "null" reducer
function NullExp() { }
function nNop(x) { return x; }
function nMulTo(x, y, r) { x.multiplyTo(y, r); }
function nSqrTo(x, r) { x.squareTo(r); }

NullExp.prototype.convert = nNop;
NullExp.prototype.revert = nNop;
NullExp.prototype.mulTo = nMulTo;
NullExp.prototype.sqrTo = nSqrTo;

// (public) this^e
function bnPow(e) { return this.exp(e, new NullExp()); }

// (protected) r = lower n words of "this * a", a.t <= n
// "this" should be the larger one if appropriate.
function bnpMultiplyLowerTo(a, n, r) {
    var i = Math.min(this.t + a.t, n);
    r.s = 0; // assumes a,this >= 0
    r.t = i;
    while (i > 0) r[--i] = 0;
    var j;
    for (j = r.t - this.t; i < j; ++i) r[i + this.t] = this.am(0, a[i], r, i, 0, this.t);
    for (j = Math.min(a.t, n); i < j; ++i) this.am(0, a[i], r, i, 0, n - i);
    r.clamp();
}

// (protected) r = "this * a" without lower n words, n > 0
// "this" should be the larger one if appropriate.
function bnpMultiplyUpperTo(a, n, r) {
    --n;
    var i = r.t = this.t + a.t - n;
    r.s = 0; // assumes a,this >= 0
    while (--i >= 0) r[i] = 0;
    for (i = Math.max(n - this.t, 0); i < a.t; ++i)
        r[this.t + i - n] = this.am(n - i, a[i], r, 0, 0, this.t + i - n);
    r.clamp();
    r.drShiftTo(1, r);
}

// Barrett modular reduction
function Barrett(m) {
    // setup Barrett
    this.r2 = nbi();
    this.q3 = nbi();
    BigInteger.ONE.dlShiftTo(2 * m.t, this.r2);
    this.mu = this.r2.divide(m);
    this.m = m;
}

function barrettConvert(x) {
    if (x.s < 0 || x.t > 2 * this.m.t) return x.mod(this.m);
    else if (x.compareTo(this.m) < 0) return x;
    else { var r = nbi(); x.copyTo(r); this.reduce(r); return r; }
}

function barrettRevert(x) { return x; }

// x = x mod m (HAC 14.42)
function barrettReduce(x) {
    x.drShiftTo(this.m.t - 1, this.r2);
    if (x.t > this.m.t + 1) { x.t = this.m.t + 1; x.clamp(); }
    this.mu.multiplyUpperTo(this.r2, this.m.t + 1, this.q3);
    this.m.multiplyLowerTo(this.q3, this.m.t + 1, this.r2);
    while (x.compareTo(this.r2) < 0) x.dAddOffset(1, this.m.t + 1);
    x.subTo(this.r2, x);
    while (x.compareTo(this.m) >= 0) x.subTo(this.m, x);
}

// r = x^2 mod m; x != r
function barrettSqrTo(x, r) { x.squareTo(r); this.reduce(r); }

// r = x*y mod m; x,y != r
function barrettMulTo(x, y, r) { x.multiplyTo(y, r); this.reduce(r); }

Barrett.prototype.convert = barrettConvert;
Barrett.prototype.revert = barrettRevert;
Barrett.prototype.reduce = barrettReduce;
Barrett.prototype.mulTo = barrettMulTo;
Barrett.prototype.sqrTo = barrettSqrTo;

// (public) this^e % m (HAC 14.85)
function bnModPow(e, m) {
    var i = e.bitLength(), k, r = nbv(1), z;
    if (i <= 0) return r;
    else if (i < 18) k = 1;
    else if (i < 48) k = 3;
    else if (i < 144) k = 4;
    else if (i < 768) k = 5;
    else k = 6;
    if (i < 8)
        z = new Classic(m);
    else if (m.isEven())
        z = new Barrett(m);
    else
        z = new Montgomery(m);

    // precomputation
    var g = new Array(), n = 3, k1 = k - 1, km = (1 << k) - 1;
    g[1] = z.convert(this);
    if (k > 1) {
        var g2 = nbi();
        z.sqrTo(g[1], g2);
        while (n <= km) {
            g[n] = nbi();
            z.mulTo(g2, g[n - 2], g[n]);
            n += 2;
        }
    }

    var j = e.t - 1, w, is1 = true, r2 = nbi(), t;
    i = nbits(e[j]) - 1;
    while (j >= 0) {
        if (i >= k1) w = (e[j] >> (i - k1)) & km;
        else {
            w = (e[j] & ((1 << (i + 1)) - 1)) << (k1 - i);
            if (j > 0) w |= e[j - 1] >> (this.DB + i - k1);
        }

        n = k;
        while ((w & 1) == 0) { w >>= 1; --n; }
        if ((i -= n) < 0) { i += this.DB; --j; }
        if (is1) {	// ret == 1, don't bother squaring or multiplying it
            g[w].copyTo(r);
            is1 = false;
        }
        else {
            while (n > 1) { z.sqrTo(r, r2); z.sqrTo(r2, r); n -= 2; }
            if (n > 0) z.sqrTo(r, r2); else { t = r; r = r2; r2 = t; }
            z.mulTo(r2, g[w], r);
        }

        while (j >= 0 && (e[j] & (1 << i)) == 0) {
            z.sqrTo(r, r2); t = r; r = r2; r2 = t;
            if (--i < 0) { i = this.DB - 1; --j; }
        }
    }
    return z.revert(r);
}

// (public) gcd(this,a) (HAC 14.54)
function bnGCD(a) {
    var x = (this.s < 0) ? this.negate() : this.clone();
    var y = (a.s < 0) ? a.negate() : a.clone();
    if (x.compareTo(y) < 0) { var t = x; x = y; y = t; }
    var i = x.getLowestSetBit(), g = y.getLowestSetBit();
    if (g < 0) return x;
    if (i < g) g = i;
    if (g > 0) {
        x.rShiftTo(g, x);
        y.rShiftTo(g, y);
    }
    while (x.signum() > 0) {
        if ((i = x.getLowestSetBit()) > 0) x.rShiftTo(i, x);
        if ((i = y.getLowestSetBit()) > 0) y.rShiftTo(i, y);
        if (x.compareTo(y) >= 0) {
            x.subTo(y, x);
            x.rShiftTo(1, x);
        }
        else {
            y.subTo(x, y);
            y.rShiftTo(1, y);
        }
    }
    if (g > 0) y.lShiftTo(g, y);
    return y;
}

// (protected) this % n, n < 2^26
function bnpModInt(n) {
    if (n <= 0) return 0;
    var d = this.DV % n, r = (this.s < 0) ? n - 1 : 0;
    if (this.t > 0)
        if (d == 0) r = this[0] % n;
        else for (var i = this.t - 1; i >= 0; --i) r = (d * r + this[i]) % n;
    return r;
}

// (public) 1/this % m (HAC 14.61)
function bnModInverse(m) {
    var ac = m.isEven();
    if ((this.isEven() && ac) || m.signum() == 0) return BigInteger.ZERO;
    var u = m.clone(), v = this.clone();
    var a = nbv(1), b = nbv(0), c = nbv(0), d = nbv(1);
    while (u.signum() != 0) {
        while (u.isEven()) {
            u.rShiftTo(1, u);
            if (ac) {
                if (!a.isEven() || !b.isEven()) { a.addTo(this, a); b.subTo(m, b); }
                a.rShiftTo(1, a);
            }
            else if (!b.isEven()) b.subTo(m, b);
            b.rShiftTo(1, b);
        }
        while (v.isEven()) {
            v.rShiftTo(1, v);
            if (ac) {
                if (!c.isEven() || !d.isEven()) { c.addTo(this, c); d.subTo(m, d); }
                c.rShiftTo(1, c);
            }
            else if (!d.isEven()) d.subTo(m, d);
            d.rShiftTo(1, d);
        }
        if (u.compareTo(v) >= 0) {
            u.subTo(v, u);
            if (ac) a.subTo(c, a);
            b.subTo(d, b);
        }
        else {
            v.subTo(u, v);
            if (ac) c.subTo(a, c);
            d.subTo(b, d);
        }
    }
    if (v.compareTo(BigInteger.ONE) != 0) return BigInteger.ZERO;
    if (d.compareTo(m) >= 0) return d.subtract(m);
    if (d.signum() < 0) d.addTo(m, d); else return d;
    if (d.signum() < 0) return d.add(m); else return d;
}

var lowprimes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223, 227, 229, 233, 239, 241, 251, 257, 263, 269, 271, 277, 281, 283, 293, 307, 311, 313, 317, 331, 337, 347, 349, 353, 359, 367, 373, 379, 383, 389, 397, 401, 409, 419, 421, 431, 433, 439, 443, 449, 457, 461, 463, 467, 479, 487, 491, 499, 503, 509];
var lplim = (1 << 26) / lowprimes[lowprimes.length - 1];

// (public) test primality with certainty >= 1-.5^t
function bnIsProbablePrime(t) {
    var i, x = this.abs();
    if (x.t == 1 && x[0] <= lowprimes[lowprimes.length - 1]) {
        for (i = 0; i < lowprimes.length; ++i)
            if (x[0] == lowprimes[i]) return true;
        return false;
    }
    if (x.isEven()) return false;
    i = 1;
    while (i < lowprimes.length) {
        var m = lowprimes[i], j = i + 1;
        while (j < lowprimes.length && m < lplim) m *= lowprimes[j++];
        m = x.modInt(m);
        while (i < j) if (m % lowprimes[i++] == 0) return false;
    }
    return x.millerRabin(t);
}

// (protected) true if probably prime (HAC 4.24, Miller-Rabin)
function bnpMillerRabin(t) {
    var n1 = this.subtract(BigInteger.ONE);
    var k = n1.getLowestSetBit();
    if (k <= 0) return false;
    var r = n1.shiftRight(k);
    t = (t + 1) >> 1;
    if (t > lowprimes.length) t = lowprimes.length;
    var a = nbi();
    for (var i = 0; i < t; ++i) {
        a.fromInt(lowprimes[i]);
        var y = a.modPow(r, this);
        if (y.compareTo(BigInteger.ONE) != 0 && y.compareTo(n1) != 0) {
            var j = 1;
            while (j++ < k && y.compareTo(n1) != 0) {
                y = y.modPowInt(2, this);
                if (y.compareTo(BigInteger.ONE) == 0) return false;
            }
            if (y.compareTo(n1) != 0) return false;
        }
    }
    return true;
}

// protected
BigInteger.prototype.chunkSize = bnpChunkSize;
BigInteger.prototype.toRadix = bnpToRadix;
BigInteger.prototype.fromRadix = bnpFromRadix;
BigInteger.prototype.fromNumber = bnpFromNumber;
BigInteger.prototype.bitwiseTo = bnpBitwiseTo;
BigInteger.prototype.changeBit = bnpChangeBit;
BigInteger.prototype.addTo = bnpAddTo;
BigInteger.prototype.dMultiply = bnpDMultiply;
BigInteger.prototype.dAddOffset = bnpDAddOffset;
BigInteger.prototype.multiplyLowerTo = bnpMultiplyLowerTo;
BigInteger.prototype.multiplyUpperTo = bnpMultiplyUpperTo;
BigInteger.prototype.modInt = bnpModInt;
BigInteger.prototype.millerRabin = bnpMillerRabin;

// public
BigInteger.prototype.clone = bnClone;
BigInteger.prototype.intValue = bnIntValue;
BigInteger.prototype.byteValue = bnByteValue;
BigInteger.prototype.shortValue = bnShortValue;
BigInteger.prototype.signum = bnSigNum;
BigInteger.prototype.toByteArray = bnToByteArray;
BigInteger.prototype.equals = bnEquals;
BigInteger.prototype.min = bnMin;
BigInteger.prototype.max = bnMax;
BigInteger.prototype.and = bnAnd;
BigInteger.prototype.or = bnOr;
BigInteger.prototype.xor = bnXor;
BigInteger.prototype.andNot = bnAndNot;
BigInteger.prototype.not = bnNot;
BigInteger.prototype.shiftLeft = bnShiftLeft;
BigInteger.prototype.shiftRight = bnShiftRight;
BigInteger.prototype.getLowestSetBit = bnGetLowestSetBit;
BigInteger.prototype.bitCount = bnBitCount;
BigInteger.prototype.testBit = bnTestBit;
BigInteger.prototype.setBit = bnSetBit;
BigInteger.prototype.clearBit = bnClearBit;
BigInteger.prototype.flipBit = bnFlipBit;
BigInteger.prototype.add = bnAdd;
BigInteger.prototype.subtract = bnSubtract;
BigInteger.prototype.multiply = bnMultiply;
BigInteger.prototype.divide = bnDivide;
BigInteger.prototype.remainder = bnRemainder;
BigInteger.prototype.divideAndRemainder = bnDivideAndRemainder;
BigInteger.prototype.modPow = bnModPow;
BigInteger.prototype.modInverse = bnModInverse;
BigInteger.prototype.pow = bnPow;
BigInteger.prototype.gcd = bnGCD;
BigInteger.prototype.isProbablePrime = bnIsProbablePrime;
/************************************************************************/
/*                                   rsa                                */
/************************************************************************/
// Depends on jsbn.js and rng.js

// Version 1.1: support utf-8 encoding in pkcs1pad2

// convert a (hex) string to a bignum object
function parseBigInt(str, r) {
    return new BigInteger(str, r);
}

function linebrk(s, n) {
    var ret = "";
    var i = 0;
    while (i + n < s.length) {
        ret += s.substring(i, i + n) + "\n";
        i += n;
    }
    return ret + s.substring(i, s.length);
}

function byte2Hex(b) {
    if (b < 0x10)
        return "0" + b.toString(16);
    else
        return b.toString(16);
}

// PKCS#1 (type 2, random) pad input string s to n bytes, and return a bigint
function pkcs1pad2(s, n) {
    if (n < s.length + 11) { // TODO: fix for utf-8
        console.log("Message too long for RSA");
        return null;
    }
    var ba = new Array();
    var i = s.length - 1;
    while (i >= 0 && n > 0) {
        var c = s.charCodeAt(i--);
        if (c < 128) { // encode using utf-8
            ba[--n] = c;
        }
        else if ((c > 127) && (c < 2048)) {
            ba[--n] = (c & 63) | 128;
            ba[--n] = (c >> 6) | 192;
        }
        else {
            ba[--n] = (c & 63) | 128;
            ba[--n] = ((c >> 6) & 63) | 128;
            ba[--n] = (c >> 12) | 224;
        }
    }
    ba[--n] = 0;
    var rng = new SecureRandom();
    var x = new Array();
    while (n > 2) { // random non-zero pad
        x[0] = 0;
        while (x[0] == 0) rng.nextBytes(x);
        ba[--n] = x[0];
    }
    ba[--n] = 2;
    ba[--n] = 0;
    return new BigInteger(ba);
}

// "empty" RSA key constructor
function RSAKey() {
    this.n = null;
    this.e = 0;
    this.d = null;
    this.p = null;
    this.q = null;
    this.dmp1 = null;
    this.dmq1 = null;
    this.coeff = null;
}

// Set the public key fields N and e from hex strings
function RSASetPublic(N, E) {
    if (N != null && E != null && N.length > 0 && E.length > 0) {
        this.n = parseBigInt(N, 16);
        this.e = parseInt(E, 16);
    }
    else
        console.log("Invalid RSA public key");
}

// Perform raw public operation on "x": return x^e (mod n)
function RSADoPublic(x) {
    return x.modPowInt(this.e, this.n);
}

// Return the PKCS#1 RSA encryption of "text" as an even-length hex string
function RSAEncrypt(text) {
    var m = pkcs1pad2(text, (this.n.bitLength() + 7) >> 3);
    if (m == null) return null;
    var c = this.doPublic(m);
    if (c == null) return null;
    var h = c.toString(16);
    if ((h.length & 1) == 0) return h; else return "0" + h;
}

// Return the PKCS#1 RSA encryption of "text" as a Base64-encoded string
//function RSAEncryptB64(text) {
//  var h = this.encrypt(text);
//  if(h) return hex2b64(h); else return null;
//}

// protected
RSAKey.prototype.doPublic = RSADoPublic;

// public
RSAKey.prototype.setPublic = RSASetPublic;
RSAKey.prototype.encrypt = RSAEncrypt;
//RSAKey.prototype.encrypt_b64 = RSAEncryptB64;

/************************************************************************/
/*                         SHA1                                         */
/************************************************************************/
sha1 = new function () {
    var blockLen = 64;
    var state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    var sttLen = state.length;

    this.hex = function (_data) {
        return toHex(getMD(_data));
    }

    this.dec = function (_data) {
        return getMD(_data);
    }

    this.bin = function (_data) {
        return pack(getMD(_data));
    }

    var getMD = function (_data) {
        var datz = [];
        if (isAry(_data)) datz = _data;
        else if (isStr(_data)) datz = unpack(_data);
        else "unknown type";
        datz = paddingData(datz);
        return round(datz);
    }

    var isAry = function (_ary) {
        return _ary && _ary.constructor === [].constructor;
    }
    var isStr = function (_str) {
        return typeof (_str) == typeof ("string");
    }

    var rotl = function (_v, _s) { return (_v << _s) | (_v >>> (32 - _s)) };

    var round = function (_blk) {
        var stt = [];
        var tmpS = [];
        var i, j, tmp, x = [];
        for (j = 0; j < sttLen; j++) stt[j] = state[j];

        for (i = 0; i < _blk.length; i += blockLen) {
            for (j = 0; j < sttLen; j++) tmpS[j] = stt[j];
            x = toBigEndian32(_blk.slice(i, i + blockLen));
            for (j = 16; j < 80; j++)
                x[j] = rotl(x[j - 3] ^ x[j - 8] ^ x[j - 14] ^ x[j - 16], 1);

            for (j = 0; j < 80; j++) {
                if (j < 20)
                    tmp = ((stt[1] & stt[2]) ^ (~stt[1] & stt[3])) + K[0];
                else if (j < 40)
                    tmp = (stt[1] ^ stt[2] ^ stt[3]) + K[1];
                else if (j < 60)
                    tmp = ((stt[1] & stt[2]) ^ (stt[1] & stt[3]) ^ (stt[2] & stt[3])) + K[2];
                else
                    tmp = (stt[1] ^ stt[2] ^ stt[3]) + K[3];

                tmp += rotl(stt[0], 5) + x[j] + stt[4];
                stt[4] = stt[3];
                stt[3] = stt[2];
                stt[2] = rotl(stt[1], 30);
                stt[1] = stt[0];
                stt[0] = tmp;
            }
            for (j = 0; j < sttLen; j++) stt[j] += tmpS[j];
        }

        return fromBigEndian32(stt);
    }

    var paddingData = function (_datz) {
        var datLen = _datz.length;
        var n = datLen;
        _datz[n++] = 0x80;
        while (n % blockLen != 56) _datz[n++] = 0;
        datLen *= 8;
        return _datz.concat(0, 0, 0, 0, fromBigEndian32([datLen]));
    }

    var toHex = function (_decz) {
        var i, hex = "";

        for (i = 0; i < _decz.length; i++)
            hex += (_decz[i] > 0xf ? "" : "0") + _decz[i].toString(16);
        return hex;
    }

    var fromBigEndian32 = function (_blk) {
        var tmp = [];
        for (n = i = 0; i < _blk.length; i++) {
            tmp[n++] = (_blk[i] >>> 24) & 0xff;
            tmp[n++] = (_blk[i] >>> 16) & 0xff;
            tmp[n++] = (_blk[i] >>> 8) & 0xff;
            tmp[n++] = _blk[i] & 0xff;
        }
        return tmp;
    }

    var toBigEndian32 = function (_blk) {
        var tmp = [];
        var i, n;
        for (n = i = 0; i < _blk.length; i += 4, n++)
            tmp[n] = (_blk[i] << 24) | (_blk[i + 1] << 16) | (_blk[i + 2] << 8) | _blk[i + 3];
        return tmp;
    }

    var unpack = function (_dat) {
        var i, n, c, tmp = [];

        for (n = i = 0; i < _dat.length; i++) {
            c = _dat.charCodeAt(i);
            if (c <= 0xff) tmp[n++] = c;
            else {
                tmp[n++] = c >>> 8;
                tmp[n++] = c & 0xff;
            }
        }
        return tmp;
    }

    var pack = function (_ary) {
        var i, tmp = "";
        for (i in _ary) tmp += String.fromCharCode(_ary[i]);
        return tmp;
    }

    var K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

}

/************************************************************************/
/*                  SHA256                                              */
/************************************************************************/
sha256 = new function () {
    var blockLen = 64;
    var state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var sttLen = state.length;

    this.hex = function (_data) {
        return toHex(getMD(_data));
    }

    this.dec = function (_data) {
        return getMD(_data);
    }

    this.bin = function (_data) {
        return pack(getMD(_data));
    }

    var getMD = function (_data) {
        var datz = [];
        if (isAry(_data)) datz = _data;
        else if (isStr(_data)) datz = unpack(_data);
        else "unknown type";
        datz = paddingData(datz);
        return round(datz);
    }

    var isAry = function (_ary) {
        return _ary && _ary.constructor === [].constructor;
    }
    var isStr = function (_str) {
        return typeof (_str) == typeof ("string");
    }

    var rotr = function (_v, _s) { return (_v >>> _s) | (_v << (32 - _s)) };

    var S0 = function (_v) { return rotr(_v, 2) ^ rotr(_v, 13) ^ rotr(_v, 22) };
    var S1 = function (_v) { return rotr(_v, 6) ^ rotr(_v, 11) ^ rotr(_v, 25) };
    var s0 = function (_v) { return rotr(_v, 7) ^ rotr(_v, 18) ^ (_v >>> 3) };
    var s1 = function (_v) { return rotr(_v, 17) ^ rotr(_v, 19) ^ (_v >>> 10) };

    var ch = function (_b, _c, _d) { return (_b & _c) ^ (~_b & _d) };
    var maj = function (_b, _c, _d) { return (_b & _c) ^ (_b & _d) ^ (_c & _d) };

    var round = function (_blk) {
        var stt = [];
        var tmpS = [];
        var i, j, tmp1, tmp2, x = [];
        for (j = 0; j < sttLen; j++) stt[j] = state[j];

        for (i = 0; i < _blk.length; i += blockLen) {
            for (j = 0; j < sttLen; j++) tmpS[j] = stt[j];
            x = toBigEndian32(_blk.slice(i, i + blockLen));
            for (j = 16; j < 64; j++)
                x[j] = s1(x[j - 2]) + x[j - 7] + s0(x[j - 15]) + x[j - 16];

            for (j = 0; j < 64; j++) {
                tmp1 = stt[7] + S1(stt[4]) + ch(stt[4], stt[5], stt[6]) + K[j] + x[j];
                tmp2 = S0(stt[0]) + maj(stt[0], stt[1], stt[2]);

                stt[7] = stt[6];
                stt[6] = stt[5];
                stt[5] = stt[4];
                stt[4] = stt[3] + tmp1;
                stt[3] = stt[2];
                stt[2] = stt[1];
                stt[1] = stt[0];
                stt[0] = tmp1 + tmp2;
            }
            for (j = 0; j < sttLen; j++) stt[j] += tmpS[j];
        }

        return fromBigEndian32(stt);
    }

    var paddingData = function (_datz) {
        var datLen = _datz.length;
        var n = datLen;
        _datz[n++] = 0x80;
        while (n % blockLen != 56) _datz[n++] = 0;
        datLen *= 8;
        return _datz.concat(0, 0, 0, 0, fromBigEndian32([datLen]));
    }

    var toHex = function (_decz) {
        var i, hex = "";

        for (i = 0; i < _decz.length; i++)
            hex += (_decz[i] > 0xf ? "" : "0") + _decz[i].toString(16);
        return hex;
    }

    var fromBigEndian32 = function (_blk) {
        var tmp = [];
        for (n = i = 0; i < _blk.length; i++) {
            tmp[n++] = (_blk[i] >>> 24) & 0xff;
            tmp[n++] = (_blk[i] >>> 16) & 0xff;
            tmp[n++] = (_blk[i] >>> 8) & 0xff;
            tmp[n++] = _blk[i] & 0xff;
        }
        return tmp;
    }

    var toBigEndian32 = function (_blk) {
        var tmp = [];
        var i, n;
        for (n = i = 0; i < _blk.length; i += 4, n++)
            tmp[n] = (_blk[i] << 24) | (_blk[i + 1] << 16) | (_blk[i + 2] << 8) | _blk[i + 3];
        return tmp;
    }

    var unpack = function (_dat) {
        var i, n, c, tmp = [];

        for (n = i = 0; i < _dat.length; i++) {
            c = _dat.charCodeAt(i);
            if (c <= 0xff) tmp[n++] = c;
            else {
                tmp[n++] = c >>> 8;
                tmp[n++] = c & 0xff;
            }
        }
        return tmp;
    }

    var pack = function (_ary) {
        var i, tmp = "";
        for (i in _ary) tmp += String.fromCharCode(_ary[i]);
        return tmp;
    }


    var K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,

        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,

        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,

        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
}

/************************************************************************/
/*                  RSA-SIGN                                            */
/************************************************************************/
// As for _RSASGIN_DIHEAD values for each hash algorithm, see PKCS#1 v2.1 spec (p38).
var _RSASIGN_DIHEAD = [];
_RSASIGN_DIHEAD['sha1'] = "3021300906052b0e03021a05000414";
_RSASIGN_DIHEAD['sha256'] = "3031300d060960864801650304020105000420";
//_RSASIGN_DIHEAD['md2'] = "3020300c06082a864886f70d020205000410";
//_RSASIGN_DIHEAD['md5'] = "3020300c06082a864886f70d020505000410";
//_RSASIGN_DIHEAD['sha384'] = "3041300d060960864801650304020205000430";
//_RSASIGN_DIHEAD['sha512'] = "3051300d060960864801650304020305000440";
var _RSASIGN_HASHHEXFUNC = [];
_RSASIGN_HASHHEXFUNC['sha1'] = sha1.hex;
_RSASIGN_HASHHEXFUNC['sha256'] = sha256.hex;

// ========================================================================
// Signature Generation
// ========================================================================

function _rsasign_getHexPaddedDigestInfoForString(s, keySize, hashAlg) {
    var pmStrLen = keySize / 4;
    var hashFunc = _RSASIGN_HASHHEXFUNC[hashAlg];
    var sHashHex = hashFunc(s);

    var sHead = "0001";
    var sTail = "00" + _RSASIGN_DIHEAD[hashAlg] + sHashHex;
    var sMid = "";
    var fLen = pmStrLen - sHead.length - sTail.length;
    for (var i = 0; i < fLen; i += 2) {
        sMid += "ff";
    }
    sPaddedMessageHex = sHead + sMid + sTail;
    return sPaddedMessageHex;
}

function _rsasign_signString(s, hashAlg) {
    var hPM = _rsasign_getHexPaddedDigestInfoForString(s, this.n.bitLength(), hashAlg);
    var biPaddedMessage = parseBigInt(hPM, 16);
    var biSign = this.doPrivate(biPaddedMessage);
    var hexSign = biSign.toString(16);
    return hexSign;
}

function _rsasign_signStringWithSHA1(s) {
    var hPM = _rsasign_getHexPaddedDigestInfoForString(s, this.n.bitLength(), 'sha1');
    var biPaddedMessage = parseBigInt(hPM, 16);
    var biSign = this.doPrivate(biPaddedMessage);
    var hexSign = biSign.toString(16);
    return hexSign;
}

function _rsasign_signStringWithSHA256(s) {
    var hPM = _rsasign_getHexPaddedDigestInfoForString(s, this.n.bitLength(), 'sha256');
    var biPaddedMessage = parseBigInt(hPM, 16);
    var biSign = this.doPrivate(biPaddedMessage);
    var hexSign = biSign.toString(16);
    return hexSign;
}

// ========================================================================
// Signature Verification
// ========================================================================

function _rsasign_getDecryptSignatureBI(biSig, hN, hE) {
    var rsa = new RSAKey();
    rsa.setPublic(hN, hE);
    var biDecryptedSig = rsa.doPublic(biSig);
    return biDecryptedSig;
}

function _rsasign_getHexDigestInfoFromSig(biSig, hN, hE) {
    var biDecryptedSig = _rsasign_getDecryptSignatureBI(biSig, hN, hE);
    var hDigestInfo = biDecryptedSig.toString(16).replace(/^1f+00/, '');
    return hDigestInfo;
}

function _rsasign_getAlgNameAndHashFromHexDisgestInfo(hDigestInfo) {
    for (var algName in _RSASIGN_DIHEAD) {
        var head = _RSASIGN_DIHEAD[algName];
        var len = head.length;
        if (hDigestInfo.substring(0, len) == head) {
            var a = [algName, hDigestInfo.substring(len)];
            return a;
        }
    }
    return [];
}

function _rsasign_verifySignatureWithArgs(sMsg, biSig, hN, hE) {
    var hDigestInfo = _rsasign_getHexDigestInfoFromSig(biSig, hN, hE);
    var digestInfoAry = _rsasign_getAlgNameAndHashFromHexDisgestInfo(hDigestInfo);
    if (digestInfoAry.length == 0) return false;
    var algName = digestInfoAry[0];
    var diHashValue = digestInfoAry[1];
    var ff = _RSASIGN_HASHHEXFUNC[algName];
    var msgHashValue = ff(sMsg);
    return (diHashValue == msgHashValue);
}

function _rsasign_verifyHexSignatureForMessage(hSig, sMsg) {
    var biSig = parseBigInt(hSig, 16);
    var result = _rsasign_verifySignatureWithArgs(sMsg, biSig,
        this.n.toString(16),
        this.e.toString(16));
    return result;
}

function _rsasign_verifyString(sMsg, hSig) {
    hSig = hSig.replace(/[ \n]+/g, "");
    var biSig = parseBigInt(hSig, 16);
    var biDecryptedSig = this.doPublic(biSig);
    var hDigestInfo = biDecryptedSig.toString(16).replace(/^1f+00/, '');
    var digestInfoAry = _rsasign_getAlgNameAndHashFromHexDisgestInfo(hDigestInfo);

    if (digestInfoAry.length == 0) return false;
    var algName = digestInfoAry[0];
    var diHashValue = digestInfoAry[1];
    var ff = _RSASIGN_HASHHEXFUNC[algName];
    var msgHashValue = ff(sMsg);
    return (diHashValue == msgHashValue);
}

RSAKey.prototype.signString = _rsasign_signString;
RSAKey.prototype.signStringWithSHA1 = _rsasign_signStringWithSHA1;
RSAKey.prototype.signStringWithSHA256 = _rsasign_signStringWithSHA256;

RSAKey.prototype.verifyString = _rsasign_verifyString;
RSAKey.prototype.verifyHexSignatureForMessage = _rsasign_verifyHexSignatureForMessage;

/************************************************************************/
/*                  BASE64                                              */
/************************************************************************/
var b64map = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var b64pad = "=";

function hex2b64(h) {
    var i;
    var c;
    var ret = "";
    for (i = 0; i + 3 <= h.length; i += 3) {
        c = parseInt(h.substring(i, i + 3), 16);
        ret += b64map.charAt(c >> 6) + b64map.charAt(c & 63);
    }
    if (i + 1 == h.length) {
        c = parseInt(h.substring(i, i + 1), 16);
        ret += b64map.charAt(c << 2);
    }
    else if (i + 2 == h.length) {
        c = parseInt(h.substring(i, i + 2), 16);
        ret += b64map.charAt(c >> 2) + b64map.charAt((c & 3) << 4);
    }
    while ((ret.length & 3) > 0) ret += b64pad;
    return ret;
}

// convert a base64 string to hex
function b64tohex(s) {
    var ret = ""
    var i;
    var k = 0; // b64 state, 0-3
    var slop;
    for (i = 0; i < s.length; ++i) {
        if (s.charAt(i) == b64pad) break;
        v = b64map.indexOf(s.charAt(i));
        if (v < 0) continue;
        if (k == 0) {
            ret += int2char(v >> 2);
            slop = v & 3;
            k = 1;
        }
        else if (k == 1) {
            ret += int2char((slop << 2) | (v >> 4));
            slop = v & 0xf;
            k = 2;
        }
        else if (k == 2) {
            ret += int2char(slop);
            ret += int2char(v >> 2);
            slop = v & 3;
            k = 3;
        }
        else {
            ret += int2char((slop << 2) | (v >> 4));
            ret += int2char(v & 0xf);
            k = 0;
        }
    }
    if (k == 1)
        ret += int2char(slop << 2);
    return ret;
}

// convert a base64 string to a byte/number array
function b64toBA(s) {
    //piggyback on b64tohex for now, optimize later
    var h = b64tohex(s);
    var i;
    var a = new Array();
    for (i = 0; 2 * i < h.length; ++i) {
        a[i] = parseInt(h.substring(2 * i, 2 * i + 2), 16);
    }
    return a;
}

/************************************************************************/
/*                  ASN1HEX                                             */
/************************************************************************/
function _asnhex_getByteLengthOfL_AtObj(s, pos) {
    if (s.substring(pos + 2, pos + 3) != '8') return 1;
    var i = parseInt(s.substring(pos + 3, pos + 4));
    if (i == 0) return -1; 		// length octet '80' indefinite length
    if (0 < i && i < 10) return i + 1; // including '8?' octet;
    return -2; 			// malformed format
}

function _asnhex_getHexOfL_AtObj(s, pos) {
    var len = _asnhex_getByteLengthOfL_AtObj(s, pos);
    if (len < 1) return '';
    return s.substring(pos + 2, pos + 2 + len * 2);
}
function _asnhex_getIntOfL_AtObj(s, pos) {
    var hLength = _asnhex_getHexOfL_AtObj(s, pos);
    if (hLength == '') return -1;
    var bi;
    if (parseInt(hLength.substring(0, 1)) < 8) {
        bi = parseBigInt(hLength, 16);
    } else {
        bi = parseBigInt(hLength.substring(2), 16);
    }
    return bi.intValue();
}

//
// get ASN.1 value starting string position 
// for ASN.1 object refered by index 'idx'.
//
function _asnhex_getStartPosOfV_AtObj(s, pos) {
    var l_len = _asnhex_getByteLengthOfL_AtObj(s, pos);
    if (l_len < 0) return l_len;
    return pos + (l_len + 1) * 2;
}

function _asnhex_getHexOfV_AtObj(s, pos) {
    var pos1 = _asnhex_getStartPosOfV_AtObj(s, pos);
    var len = _asnhex_getIntOfL_AtObj(s, pos);
    return s.substring(pos1, pos1 + len * 2);
}

function _asnhex_getPosOfNextSibling_AtObj(s, pos) {
    var pos1 = _asnhex_getStartPosOfV_AtObj(s, pos);
    var len = _asnhex_getIntOfL_AtObj(s, pos);
    return pos1 + len * 2;
}

function _asnhex_getPosArrayOfChildren_AtObj(h, pos) {
    var a = new Array();
    var p0 = _asnhex_getStartPosOfV_AtObj(h, pos);
    a.push(p0);

    var len = _asnhex_getIntOfL_AtObj(h, pos);
    var p = p0;
    var k = 0;
    while (1) {
        var pNext = _asnhex_getPosOfNextSibling_AtObj(h, p);
        if (pNext == null || (pNext - p0 >= (len * 2))) break;
        if (k >= 200) break;

        a.push(pNext);
        p = pNext;

        k++;
    }

    return a;
}

/************************************************************************/
/*                  X509Cert                                            */
/************************************************************************/
function _x509_pemToBase64(sCertPEM) {
    var s = sCertPEM;
    if (s.indexOf("CERTIFICATE") > -1) {
        s = s.replace("-----BEGIN CERTIFICATE-----", "");
        s = s.replace("-----END CERTIFICATE-----", "");
    }
    if (s.indexOf("PUBLIC KEY") > -1) {
        s = s.replace("-----BEGIN PUBLIC KEY-----", "");
        s = s.replace("-----END PUBLIC KEY-----", "");
    }
    s = s.replace(/[ \n]+/g, "");
    return s;
}

function _x509_pemToHex(sCertPEM) {
    var b64Cert = _x509_pemToBase64(sCertPEM);
    var hCert = b64tohex(b64Cert);
    return hCert;
}

function _x509_getHexTbsCertificateFromCert(hCert) {
    var pTbsCert = _asnhex_getStartPosOfV_AtObj(hCert, 0);
    return pTbsCert;
}

// NOTE: privateKeyUsagePeriod field of X509v2 not supported.
// NOTE: v1 and v3 supported
function _x509_getSubjectPublicKeyInfoPosFromCertHex(hCert) {
    var pTbsCert = _asnhex_getStartPosOfV_AtObj(hCert, 0);
    var a = _asnhex_getPosArrayOfChildren_AtObj(hCert, pTbsCert);
    if (a.length < 1) return -1;
    if (hCert.substring(a[0], a[0] + 10) == "a003020102") { // v3
        if (a.length < 6) return -1;
        return a[6];
    } else {
        if (a.length < 5) return -1;
        return a[5];
    }
}

// NOTE: Without BITSTRING encapsulation.
function _x509_getSubjectPublicKeyPosFromCertHex(hCert) {
    var pInfo = _x509_getSubjectPublicKeyInfoPosFromCertHex(hCert);
    if (pInfo == -1) return -1;
    var a = _asnhex_getPosArrayOfChildren_AtObj(hCert, pInfo);
    if (a.length != 2) return -1;
    var pBitString = a[1];
    if (hCert.substring(pBitString, pBitString + 2) != '03') return -1;
    var pBitStringV = _asnhex_getStartPosOfV_AtObj(hCert, pBitString);

    if (hCert.substring(pBitStringV, pBitStringV + 2) != '00') return -1;
    return pBitStringV + 2;
}

function _x509_getPublicKeyHexArrayFromCertHex(hCert) {
    var p = _x509_getSubjectPublicKeyPosFromCertHex(hCert);
    var a = _asnhex_getPosArrayOfChildren_AtObj(hCert, p);
    if (a.length != 2) return [];
    var hN = _asnhex_getHexOfV_AtObj(hCert, a[0]);
    var hE = _asnhex_getHexOfV_AtObj(hCert, a[1]);
    if (hN != null && hE != null) {
        return [hN, hE];
    } else {
        return [];
    }
}

function _x509_getPublicKeyHexArrayFromCertPEM(sCertPEM) {
    var hCert = _x509_pemToHex(sCertPEM);
    var a = _x509_getPublicKeyHexArrayFromCertHex(hCert);
    return a;
}

function _x509_readCertPEM(sCertPEM) {
    var hCert = _x509_pemToHex(sCertPEM);
    var a = _x509_getPublicKeyHexArrayFromCertHex(hCert);
    var rsa = new RSAKey();
    rsa.setPublic(a[0], a[1]);
    this.subjectPublicKeyRSA = rsa;
    this.subjectPublicKeyRSA_hN = a[0];
    this.subjectPublicKeyRSA_hE = a[1];
}

function _x509_readCertPEMWithoutRSAInit(sCertPEM) {
    var hCert = _x509_pemToHex(sCertPEM);
    var a = _x509_getPublicKeyHexArrayFromCertHex(hCert);
    this.subjectPublicKeyRSA.setPublic(a[0], a[1]);
    this.subjectPublicKeyRSA_hN = a[0];
    this.subjectPublicKeyRSA_hE = a[1];
}

function X509() {
    this.subjectPublicKeyRSA = null;
    this.subjectPublicKeyRSA_hN = null;
    this.subjectPublicKeyRSA_hE = null;
}
X509.prototype.readCertPEM = _x509_readCertPEM;
X509.prototype.readCertPEMWithoutRSAInit = _x509_readCertPEMWithoutRSAInit;
/************************************************************************/
/*                  VERIFY                                              */
/************************************************************************/
var x509Cert = '-----BEGIN CERTIFICATE-----\n' +
    'MIID4jCCAsqgAwIBAgIEWcterDANBgkqhkiG9w0BAQsFADCBsjELMAkGA1UEBhMC\n' +
    'Vk4xEjAQBgNVBAgMCUjDoCBO4buZaTEVMBMGA1UEBwwMQ+G6p3UgR2nhuqV5MRYw\n' +
    'FAYDVQQKDA1WTlBUIFNvZnR3YXJlMTgwNgYDVQQLDC9QaMOybmcgR2nhuqNpIHBo\n' +
    'w6FwIENo4bupbmcgdGjhu7FjIMSQaeG7h24gdOG7rTEmMCQGA1UEAwwdVk5QVC1D\n' +
    'QSBQbHVnaW4gQXV0aGVudGljYXRpb24wHhcNMTcwOTI3MDgxOTAwWhcNMTgwOTI3\n' +
    'MDgxOTAwWjCBsjELMAkGA1UEBhMCVk4xEjAQBgNVBAgMCUjDoCBO4buZaTEVMBMG\n' +
    'A1UEBwwMQ+G6p3UgR2nhuqV5MRYwFAYDVQQKDA1WTlBUIFNvZnR3YXJlMTgwNgYD\n' +
    'VQQLDC9QaMOybmcgR2nhuqNpIHBow6FwIENo4bupbmcgdGjhu7FjIMSQaeG7h24g\n' +
    'dOG7rTEmMCQGA1UEAwwdVk5QVC1DQSBQbHVnaW4gQXV0aGVudGljYXRpb24wggEi\n' +
    'MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCNXA/sRTeNhPww8bC7Yv1r/pjr\n' +
    'YXTbQ4nw1oNXx7sxQOElIL+ytUUcF91FqsuBlwyEYJa2wTi2hwMXZjZtxFPhMviW\n' +
    '1Y0AoCT3Yu76K7o4SUmYLSX+pe8+F9CJUUiFoQ1DrBzNUeMH+boZB0GDCpcC8Og7\n' +
    'kRhnGBNocARnX0Nk2wq0gU/xRm01kFHPzHFP9t4KMvYfdBGZH/qohbV1l2I3yD39\n' +
    'tO9vKqM49S1UIADNwzjtGAkrkZjnOkXILPDawZuGQ6w8ftDN52ZSS6lgKFcHlC5d\n' +
    '7YkMFVqZ/M0NkOIjoZDjhDUfKO78gWNaEJVeR+wMVot/47hb3avv0EEXonEhAgMB\n' +
    'AAEwDQYJKoZIhvcNAQELBQADggEBAAYn1U5T9Qu5W33U4muA7OnWaQrHQ9P64sbn\n' +
    'blfyuvdrvvK2NUTSnvkt5/UB1MCUPAwqkiWYAiBm1ECAZ0sT8Ia5maplX2+BEx3f\n' +
    'j22wdkMAKoMfxQt/3bXONeJEftviOTmzeif9jcNpAbJj/pklKyy5KviN61Rlwm3Q\n' +
    'fUUaTKHlUTSX6i7CGLCPANLP8Q+loCytwUije0HS5CXoGXkhC57zRUrzny9jBPrw\n' +
    'vPN5/aD2Qf33oQ5Xzf06l0PIMFeeWAi4G6ExsHHv7iUJ8klTTbDuHoWabWMWOKZo\n' +
    'FRAhKb5sZNqhAjIoTVQLRpdFHbIS64fUegtFGefDqw2RPIHO0og=\n' +
    '-----END CERTIFICATE-----';


function doVerify(sMsg, hSig) {
    var x509 = new X509();
    x509.readCertPEM(x509Cert);
    var result = x509.subjectPublicKeyRSA.verifyString(sMsg, hSig);
    return result;
}
//  json2.js
//  2016-10-28
//  Public Domain.
//  NO WARRANTY EXPRESSED OR IMPLIED. USE AT YOUR OWN RISK.
//  See http://www.JSON.org/js.html
//  This code should be minified before deployment.
//  See http://javascript.crockford.com/jsmin.html

//  USE YOUR OWN COPY. IT IS EXTREMELY UNWISE TO LOAD CODE FROM SERVERS YOU DO
//  NOT CONTROL.

//  This file creates a global JSON object containing two methods: stringify
//  and parse. This file provides the ES5 JSON capability to ES3 systems.
//  If a project might run on IE8 or earlier, then this file should be included.
//  This file does nothing on ES5 systems.

//      JSON.stringify(value, replacer, space)
//          value       any JavaScript value, usually an object or array.
//          replacer    an optional parameter that determines how object
//                      values are stringified for objects. It can be a
//                      function or an array of strings.
//          space       an optional parameter that specifies the indentation
//                      of nested structures. If it is omitted, the text will
//                      be packed without extra whitespace. If it is a number,
//                      it will specify the number of spaces to indent at each
//                      level. If it is a string (such as "\t" or "&nbsp;"),
//                      it contains the characters used to indent at each level.
//          This method produces a JSON text from a JavaScript value.
//          When an object value is found, if the object contains a toJSON
//          method, its toJSON method will be called and the result will be
//          stringified. A toJSON method does not serialize: it returns the
//          value represented by the name/value pair that should be serialized,
//          or undefined if nothing should be serialized. The toJSON method
//          will be passed the key associated with the value, and this will be
//          bound to the value.

//          For example, this would serialize Dates as ISO strings.

//              Date.prototype.toJSON = function (key) {
//                  function f(n) {
//                      // Format integers to have at least two digits.
//                      return (n < 10)
//                          ? "0" + n
//                          : n;
//                  }
//                  return this.getUTCFullYear()   + "-" +
//                       f(this.getUTCMonth() + 1) + "-" +
//                       f(this.getUTCDate())      + "T" +
//                       f(this.getUTCHours())     + ":" +
//                       f(this.getUTCMinutes())   + ":" +
//                       f(this.getUTCSeconds())   + "Z";
//              };

//          You can provide an optional replacer method. It will be passed the
//          key and value of each member, with this bound to the containing
//          object. The value that is returned from your method will be
//          serialized. If your method returns undefined, then the member will
//          be excluded from the serialization.

//          If the replacer parameter is an array of strings, then it will be
//          used to select the members to be serialized. It filters the results
//          such that only members with keys listed in the replacer array are
//          stringified.

//          Values that do not have JSON representations, such as undefined or
//          functions, will not be serialized. Such values in objects will be
//          dropped; in arrays they will be replaced with null. You can use
//          a replacer function to replace those with JSON values.

//          JSON.stringify(undefined) returns undefined.

//          The optional space parameter produces a stringification of the
//          value that is filled with line breaks and indentation to make it
//          easier to read.

//          If the space parameter is a non-empty string, then that string will
//          be used for indentation. If the space parameter is a number, then
//          the indentation will be that many spaces.

//          Example:

//          text = JSON.stringify(["e", {pluribus: "unum"}]);
//          // text is '["e",{"pluribus":"unum"}]'

//          text = JSON.stringify(["e", {pluribus: "unum"}], null, "\t");
//          // text is '[\n\t"e",\n\t{\n\t\t"pluribus": "unum"\n\t}\n]'

//          text = JSON.stringify([new Date()], function (key, value) {
//              return this[key] instanceof Date
//                  ? "Date(" + this[key] + ")"
//                  : value;
//          });
//          // text is '["Date(---current time---)"]'

//      JSON.parse(text, reviver)
//          This method parses a JSON text to produce an object or array.
//          It can throw a SyntaxError exception.

//          The optional reviver parameter is a function that can filter and
//          transform the results. It receives each of the keys and values,
//          and its return value is used instead of the original value.
//          If it returns what it received, then the structure is not modified.
//          If it returns undefined then the member is deleted.

//          Example:

//          // Parse the text. Values that look like ISO date strings will
//          // be converted to Date objects.

//          myData = JSON.parse(text, function (key, value) {
//              var a;
//              if (typeof value === "string") {
//                  a =
//   /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)Z$/.exec(value);
//                  if (a) {
//                      return new Date(Date.UTC(+a[1], +a[2] - 1, +a[3], +a[4],
//                          +a[5], +a[6]));
//                  }
//              }
//              return value;
//          });

//          myData = JSON.parse('["Date(09/09/2001)"]', function (key, value) {
//              var d;
//              if (typeof value === "string" &&
//                      value.slice(0, 5) === "Date(" &&
//                      value.slice(-1) === ")") {
//                  d = new Date(value.slice(5, -1));
//                  if (d) {
//                      return d;
//                  }
//              }
//              return value;
//          });

//  This is a reference implementation. You are free to copy, modify, or
//  redistribute.

/*jslint
    eval, for, this
*/

/*property
    JSON, apply, call, charCodeAt, getUTCDate, getUTCFullYear, getUTCHours,
    getUTCMinutes, getUTCMonth, getUTCSeconds, hasOwnProperty, join,
    lastIndex, length, parse, prototype, push, replace, slice, stringify,
    test, toJSON, toString, valueOf
*/


// Create a JSON object only if one does not already exist. We create the
// methods in a closure to avoid creating global variables.

if (typeof JSON !== "object") {
    JSON = {};
}

(function () {
    "use strict";

    var rx_one = /^[\],:{}\s]*$/;
    var rx_two = /\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g;
    var rx_three = /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g;
    var rx_four = /(?:^|:|,)(?:\s*\[)+/g;
    var rx_escapable = /[\\"\u0000-\u001f\u007f-\u009f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;
    var rx_dangerous = /[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;

    function f(n) {
        // Format integers to have at least two digits.
        return n < 10
            ? "0" + n
            : n;
    }

    function this_value() {
        return this.valueOf();
    }

    if (typeof Date.prototype.toJSON !== "function") {

        Date.prototype.toJSON = function () {

            return isFinite(this.valueOf())
                ? this.getUTCFullYear() + "-" +
                f(this.getUTCMonth() + 1) + "-" +
                f(this.getUTCDate()) + "T" +
                f(this.getUTCHours()) + ":" +
                f(this.getUTCMinutes()) + ":" +
                f(this.getUTCSeconds()) + "Z"
                : null;
        };

        Boolean.prototype.toJSON = this_value;
        Number.prototype.toJSON = this_value;
        String.prototype.toJSON = this_value;
    }

    var gap;
    var indent;
    var meta;
    var rep;


    function quote(string) {

        // If the string contains no control characters, no quote characters, and no
        // backslash characters, then we can safely slap some quotes around it.
        // Otherwise we must also replace the offending characters with safe escape
        // sequences.

        rx_escapable.lastIndex = 0;
        return rx_escapable.test(string)
            ? "\"" + string.replace(rx_escapable, function (a) {
                var c = meta[a];
                return typeof c === "string"
                    ? c
                    : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
            }) + "\""
            : "\"" + string + "\"";
    }


    function str(key, holder) {

        // Produce a string from holder[key].

        var i;          // The loop counter.
        var k;          // The member key.
        var v;          // The member value.
        var length;
        var mind = gap;
        var partial;
        var value = holder[key];

        // If the value has a toJSON method, call it to obtain a replacement value.

        if (value && typeof value === "object" &&
            typeof value.toJSON === "function") {
            value = value.toJSON(key);
        }

        // If we were called with a replacer function, then call the replacer to
        // obtain a replacement value.

        if (typeof rep === "function") {
            value = rep.call(holder, key, value);
        }

        // What happens next depends on the value's type.

        switch (typeof value) {
            case "string":
                return quote(value);

            case "number":

                // JSON numbers must be finite. Encode non-finite numbers as null.

                return isFinite(value)
                    ? String(value)
                    : "null";

            case "boolean":
            case "null":

                // If the value is a boolean or null, convert it to a string. Note:
                // typeof null does not produce "null". The case is included here in
                // the remote chance that this gets fixed someday.

                return String(value);

            // If the type is "object", we might be dealing with an object or an array or
            // null.

            case "object":

                // Due to a specification blunder in ECMAScript, typeof null is "object",
                // so watch out for that case.

                if (!value) {
                    return "null";
                }

                // Make an array to hold the partial results of stringifying this object value.

                gap += indent;
                partial = [];

                // Is the value an array?

                if (Object.prototype.toString.apply(value) === "[object Array]") {

                    // The value is an array. Stringify every element. Use null as a placeholder
                    // for non-JSON values.

                    length = value.length;
                    for (i = 0; i < length; i += 1) {
                        partial[i] = str(i, value) || "null";
                    }

                    // Join all of the elements together, separated with commas, and wrap them in
                    // brackets.

                    v = partial.length === 0
                        ? "[]"
                        : gap
                            ? "[\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "]"
                            : "[" + partial.join(",") + "]";
                    gap = mind;
                    return v;
                }

                // If the replacer is an array, use it to select the members to be stringified.

                if (rep && typeof rep === "object") {
                    length = rep.length;
                    for (i = 0; i < length; i += 1) {
                        if (typeof rep[i] === "string") {
                            k = rep[i];
                            v = str(k, value);
                            if (v) {
                                partial.push(quote(k) + (
                                    gap
                                        ? ": "
                                        : ":"
                                ) + v);
                            }
                        }
                    }
                } else {

                    // Otherwise, iterate through all of the keys in the object.

                    for (k in value) {
                        if (Object.prototype.hasOwnProperty.call(value, k)) {
                            v = str(k, value);
                            if (v) {
                                partial.push(quote(k) + (
                                    gap
                                        ? ": "
                                        : ":"
                                ) + v);
                            }
                        }
                    }
                }

                // Join all of the member texts together, separated with commas,
                // and wrap them in braces.

                v = partial.length === 0
                    ? "{}"
                    : gap
                        ? "{\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "}"
                        : "{" + partial.join(",") + "}";
                gap = mind;
                return v;
        }
    }

    // If the JSON object does not yet have a stringify method, give it one.

    if (typeof JSON.stringify !== "function") {
        meta = {    // table of character substitutions
            "\b": "\\b",
            "\t": "\\t",
            "\n": "\\n",
            "\f": "\\f",
            "\r": "\\r",
            "\"": "\\\"",
            "\\": "\\\\"
        };
        JSON.stringify = function (value, replacer, space) {

            // The stringify method takes a value and an optional replacer, and an optional
            // space parameter, and returns a JSON text. The replacer can be a function
            // that can replace values, or an array of strings that will select the keys.
            // A default replacer method can be provided. Use of the space parameter can
            // produce text that is more easily readable.

            var i;
            gap = "";
            indent = "";

            // If the space parameter is a number, make an indent string containing that
            // many spaces.

            if (typeof space === "number") {
                for (i = 0; i < space; i += 1) {
                    indent += " ";
                }

                // If the space parameter is a string, it will be used as the indent string.

            } else if (typeof space === "string") {
                indent = space;
            }

            // If there is a replacer, it must be a function or an array.
            // Otherwise, throw an error.

            rep = replacer;
            if (replacer && typeof replacer !== "function" &&
                (typeof replacer !== "object" ||
                    typeof replacer.length !== "number")) {
                throw new Error("JSON.stringify");
            }

            // Make a fake root object containing our value under the key of "".
            // Return the result of stringifying the value.

            return str("", { "": value });
        };
    }


    // If the JSON object does not yet have a parse method, give it one.

    if (typeof JSON.parse !== "function") {
        JSON.parse = function (text, reviver) {

            // The parse method takes a text and an optional reviver function, and returns
            // a JavaScript value if the text is a valid JSON text.

            var j;

            function walk(holder, key) {

                // The walk method is used to recursively walk the resulting structure so
                // that modifications can be made.

                var k;
                var v;
                var value = holder[key];
                if (value && typeof value === "object") {
                    for (k in value) {
                        if (Object.prototype.hasOwnProperty.call(value, k)) {
                            v = walk(value, k);
                            if (v !== undefined) {
                                value[k] = v;
                            } else {
                                delete value[k];
                            }
                        }
                    }
                }
                return reviver.call(holder, key, value);
            }


            // Parsing happens in four stages. In the first stage, we replace certain
            // Unicode characters with escape sequences. JavaScript handles many characters
            // incorrectly, either silently deleting them, or treating them as line endings.

            text = String(text);
            rx_dangerous.lastIndex = 0;
            if (rx_dangerous.test(text)) {
                text = text.replace(rx_dangerous, function (a) {
                    return "\\u" +
                        ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
                });
            }

            // In the second stage, we run the text against regular expressions that look
            // for non-JSON patterns. We are especially concerned with "()" and "new"
            // because they can cause invocation, and "=" because it can cause mutation.
            // But just to be safe, we want to reject all unexpected forms.

            // We split the second stage into 4 regexp operations in order to work around
            // crippling inefficiencies in IE's and Safari's regexp engines. First we
            // replace the JSON backslash pairs with "@" (a non-JSON character). Second, we
            // replace all simple value tokens with "]" characters. Third, we delete all
            // open brackets that follow a colon or comma or that begin the text. Finally,
            // we look to see that the remaining characters are only whitespace or "]" or
            // "," or ":" or "{" or "}". If that is so, then the text is safe for eval.

            if (
                rx_one.test(
                    text
                        .replace(rx_two, "@")
                        .replace(rx_three, "]")
                        .replace(rx_four, "")
                )
            ) {

                // In the third stage we use the eval function to compile the text into a
                // JavaScript structure. The "{" operator is subject to a syntactic ambiguity
                // in JavaScript: it can begin a block or an object literal. We wrap the text
                // in parens to eliminate the ambiguity.

                j = eval("(" + text + ")");

                // In the optional fourth stage, we recursively walk the new structure, passing
                // each name/value pair to a reviver function for possible transformation.

                return (typeof reviver === "function")
                    ? walk({ "": j }, "")
                    : j;
            }

            // If the text is not JSON parseable, then a SyntaxError is thrown.

            throw new SyntaxError("JSON.parse");
        };
    }
}());
// Detect custom browser protocol
(function (f) { if (typeof exports === "object" && typeof module !== "undefined") { module.exports = f() } else if (typeof define === "function" && define.amd) { define([], f) } else { var g; if (typeof window !== "undefined") { g = window } else if (typeof global !== "undefined") { g = global } else if (typeof self !== "undefined") { g = self } else { g = this } g.protocolCheck = f() } })(function () {
    var define, module, exports; return (function e(t, n, r) { function s(o, u) { if (!n[o]) { if (!t[o]) { var a = typeof require == "function" && require; if (!u && a) return a(o, !0); if (i) return i(o, !0); var f = new Error("Cannot find module '" + o + "'"); throw f.code = "MODULE_NOT_FOUND", f } var l = n[o] = { exports: {} }; t[o][0].call(l.exports, function (e) { var n = t[o][1][e]; return s(n ? n : e) }, l, l.exports, e, t, n, r) } return n[o].exports } var i = typeof require == "function" && require; for (var o = 0; o < r.length; o++)s(r[o]); return s })({
        1: [function (require, module, exports) {
            function _registerEvent(target, eventType, cb) {
                if (target.addEventListener) {
                    target.addEventListener(eventType, cb);
                    return {
                        remove: function () {
                            target.removeEventListener(eventType, cb);
                        }
                    };
                } else {
                    target.attachEvent(eventType, cb);
                    return {
                        remove: function () {
                            target.detachEvent(eventType, cb);
                        }
                    };
                }
            }

            function _createHiddenIframe(target, uri) {
                var iframe = document.createElement("iframe");
                iframe.src = uri;
                iframe.id = "hiddenIframe";
                iframe.style.display = "none";
                target.appendChild(iframe);

                return iframe;
            }

            function openUriWithHiddenFrame(uri, failCb, successCb) {

                var timeout = setTimeout(function () {
                    failCb();
                    handler.remove();
                }, 1000);

                var iframe = document.querySelector("#hiddenIframe");
                if (!iframe) {
                    iframe = _createHiddenIframe(document.body, "about:blank");
                }

                var handler = _registerEvent(window, "blur", onBlur);

                function onBlur() {
                    clearTimeout(timeout);
                    handler.remove();
                    successCb();
                }

                iframe.contentWindow.location.href = uri;
            }

            function openUriWithTimeoutHack(uri, failCb, successCb) {

                var timeout = setTimeout(function () {
                    failCb();
                    handler.remove();
                }, 1000);

                //handle page running in an iframe (blur must be registered with top level window)
                var target = window;
                while (target != target.parent) {
                    target = target.parent;
                }

                var handler = _registerEvent(target, "blur", onBlur);

                function onBlur() {
                    clearTimeout(timeout);
                    handler.remove();
                    successCb();
                }

                window.location = uri;
            }

            function openUriUsingFirefox(uri, failCb, successCb) {
                var iframe = document.querySelector("#hiddenIframe");

                if (!iframe) {
                    iframe = _createHiddenIframe(document.body, "about:blank");
                }

                try {
                    iframe.contentWindow.location.href = uri;
                    successCb();
                } catch (e) {
                    if (e.name == "NS_ERROR_UNKNOWN_PROTOCOL") {
                        failCb();
                    }
                }
            }

            function openUriUsingIEInOlderWindows(uri, failCb, successCb) {
                if (getInternetExplorerVersion() === 10) {
                    openUriUsingIE10InWindows7(uri, failCb, successCb);
                } else if (getInternetExplorerVersion() === 9 || getInternetExplorerVersion() === 11) {
                    openUriWithHiddenFrame(uri, failCb, successCb);
                } else {
                    openUriInNewWindowHack(uri, failCb, successCb);
                }
            }

            function openUriUsingIE10InWindows7(uri, failCb, successCb) {
                var timeout = setTimeout(failCb, 1000);
                window.addEventListener("blur", function () {
                    clearTimeout(timeout);
                    successCb();
                });

                var iframe = document.querySelector("#hiddenIframe");
                if (!iframe) {
                    iframe = _createHiddenIframe(document.body, "about:blank");
                }
                try {
                    iframe.contentWindow.location.href = uri;
                } catch (e) {
                    failCb();
                    clearTimeout(timeout);
                }
            }

            function openUriInNewWindowHack(uri, failCb, successCb) {
                var myWindow = window.open('', '', 'width=0,height=0');

                myWindow.document.write("<iframe src='" + uri + "'></iframe>");

                setTimeout(function () {
                    try {
                        myWindow.location.href;
                        myWindow.setTimeout("window.close()", 1000);
                        successCb();
                    } catch (e) {
                        myWindow.close();
                        failCb();
                    }
                }, 1000);
            }

            function openUriWithMsLaunchUri(uri, failCb, successCb) {
                navigator.msLaunchUri(uri,
                    successCb,
                    failCb
                );
            }

            function checkBrowser() {
                var isOpera = !!window.opera || navigator.userAgent.indexOf(' OPR/') >= 0;
                return {
                    isOpera: isOpera,
                    isFirefox: typeof InstallTrigger !== 'undefined',
                    isSafari: Object.prototype.toString.call(window.HTMLElement).indexOf('Constructor') > 0,
                    isChrome: !!window.chrome && !isOpera,
                    isIE: /*@cc_on!@*/false || !!document.documentMode // At least IE6
                }
            }

            function getInternetExplorerVersion() {
                var rv = -1;
                if (navigator.appName === "Microsoft Internet Explorer") {
                    var ua = navigator.userAgent;
                    var re = new RegExp("MSIE ([0-9]{1,}[\.0-9]{0,})");
                    if (re.exec(ua) != null)
                        rv = parseFloat(RegExp.$1);
                }
                else if (navigator.appName === "Netscape") {
                    var ua = navigator.userAgent;
                    var re = new RegExp("Trident/.*rv:([0-9]{1,}[\.0-9]{0,})");
                    if (re.exec(ua) != null) {
                        rv = parseFloat(RegExp.$1);
                    }
                }
                return rv;
            }

            module.exports = function (uri, failCb, successCb) {
                function failCallback() {
                    failCb && failCb();
                }

                function successCallback() {
                    successCb && successCb();
                }

                if (navigator.msLaunchUri) { //for IE and Edge in Win 8 and Win 10
                    openUriWithMsLaunchUri(uri, failCb, successCb);
                } else {
                    var browser = checkBrowser();

                    if (browser.isFirefox) {
                        openUriUsingFirefox(uri, failCallback, successCallback);
                    } else if (browser.isChrome) {
                        openUriWithTimeoutHack(uri, failCallback, successCallback);
                    } else if (browser.isIE) {
                        openUriUsingIEInOlderWindows(uri, failCallback, successCallback);
                    } else {
                        //not supported, implement please
                    }
                }
            }

        }, {}]
    }, {}, [1])(1)
});