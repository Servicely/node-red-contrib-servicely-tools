module.exports = function(RED) {
    "use strict";
    const { spawn } = require('child_process');
    const { quote } = require('shell-quote'); // Corrected package name
    const vm = require('node:vm'); // Use the built-in vm module for sandboxing
    // Removed vm2 require for now, using simpler RED.util.Script

    // Helper function to safely run user scripts using vm module
    async function runScript(scriptCode, executionContext, nodeContext) {
        // Merge the node context (node, config, context, env, util, Buffer, require) 
        // with the execution-specific context (msg, originalMsg, type, etc.)
        const fullContext = { ...nodeContext, ...executionContext };
        
        // Create a sandboxed context
        const context = vm.createContext(fullContext);

        // Execute the script within the sandboxed context
        // Wrap in Promise as runInContext is synchronous but we keep the async pattern
        return new Promise((resolve, reject) => {
            try {
                const result = vm.runInContext(scriptCode, context, {
                    // Set a timeout to prevent runaway scripts (e.g., 1 second)
                    timeout: 1000 
                });
                // The script modifies the context directly (e.g., context.msg)
                // We need to return the relevant modified object (usually msg)
                resolve(context.msg);
            } catch (err) {
                reject(err);
            }
        });
    }


    function ServicelyExecNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.activeProcesses = {}; // Keep track of active child processes

        // Store config
        node.name = config.name;
        node.command = config.command;
        node.commandArgs = config.commandArgs;
        node.cwd = config.cwd;
        node.envProperty = config.envProperty;
        node.shell = config.shell;
        node.payloadIs = config.payloadIs || "argument";
        node.minError = parseInt(config.minError) || 1;
        node.minWarning = config.minWarning !== "" ? parseInt(config.minWarning) : null;
        node.argumentsSourceProperty = config.argumentsSourceProperty || "payload"; // NEW
        node.preProcessScript = config.preProcessScript;
        node.postProcessScript = config.postProcessScript;
        node.sendStartControl = config.sendStartControl || false; // Read the new option
        node.resultSource = config.resultSource || "payload"; // NEW: Where results go

        // Prepare the sandbox context for scripts
        const sandboxContext = {
            node: {
                id: node.id,
                name: node.name,
                log: node.log.bind(node),
                warn: node.warn.bind(node),
                error: node.error.bind(node),
                status: node.status.bind(node),
            },
            config: config, // Expose node configuration
            context: {
                get: (key, store) => node.context().get(key, store),
                set: (key, value, store) => node.context().set(key, value, store),
                keys: (store) => node.context().keys(store),
                flow: {
                    get: (key, store) => node.context().flow.get(key, store),
                    set: (key, value, store) => node.context().flow.set(key, value, store),
                    keys: (store) => node.context().flow.keys(store),
                },
                global: {
                    get: (key, store) => node.context().global.get(key, store),
                    set: (key, value, store) => node.context().global.set(key, value, store),
                    keys: (store) => node.context().global.keys(store),
                },
            },
            env: {
                get: (name) => RED.util.evaluateNodeProperty(name, 'env', node),
            },
            util: RED.util, // Expose RED util functions
            Buffer: Buffer, // Expose Buffer
            require: (moduleName) => {
                 // Basic whitelist for require to prevent arbitrary code execution
                 // Expand this list cautiously based on needs
                const allowedModules = ['os', 'path', 'fs', 'util', 'crypto', 'querystring', 'string_decoder', 'url', 'zlib'];
                if (allowedModules.includes(moduleName)) {
                    return require(moduleName);
                } else {
                    throw new Error(`Module '${moduleName}' is not allowed in script.`);
                }
            }
        };

        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node,arguments); };
            const originalMsg = RED.util.cloneMessage(msg); // Keep for post-processing context
            let currentMsg = msg; // This msg object will be modified by pre-processing

            node.status({ fill: "grey", shape: "dot", text: "preprocessing..." });

            // --- 1. Pre-processing --- (Error handling simplified for brevity)
            if (node.preProcessScript) {
                try {
                    const preProcessContext = { msg: currentMsg }; // Execution-specific context
                    // Pass sandboxContext as the base, preProcessContext for execution specifics
                    currentMsg = await runScript(node.preProcessScript, preProcessContext, sandboxContext);
                    if (currentMsg === null || typeof currentMsg === 'undefined') {
                        node.log("Pre-processing script returned null/undefined, dropping message.");
                        node.status({}); if (done) { done(); } return;
                    }
                } catch (err) {
                    node.error("Pre-processing script error: " + err.toString(), originalMsg);
                    node.status({fill:"red",shape:"dot",text:"pre-script error"}); if (done) { done(err); } return;
                }
            }

            // --- 2. Determine Command, Args, Options --- (Error handling simplified)
            let commandToRun = node.command;
            let commandArgsToRun = [];
            let commandOptions = {
                shell: node.shell,
                env: { ...process.env },
                stdio: ['pipe', 'pipe', 'pipe']
            };
            try {
                commandOptions.cwd = node.cwd ? RED.util.evaluateNodeProperty(node.cwd, 'str', node, currentMsg) : undefined;
            } catch (err) {
                node.error(`Failed to evaluate CWD: ${err.message}`, originalMsg);
                node.status({fill:"red",shape:"dot",text:"invalid cwd"}); if (done) { done(err); } return;
            }
            if (node.envProperty) {
                try {
                    const envVars = RED.util.getMessageProperty(currentMsg, node.envProperty);
                    if (envVars && typeof envVars === 'object') {
                        for (const key in envVars) {
                            if (Object.hasOwnProperty.call(envVars, key)) {
                                // --- Add logging here ---
                                node.log(`Setting env var from msg.${node.envProperty}: ${key}=${String(envVars[key])}`);
                                
                                // --- End logging ---
                                commandOptions.env[key] = String(envVars[key]);
                            }
                        }
                    }
                } catch (err) { /* Log or ignore error */ }
            }
            
            // Determine Arguments based on argumentsSourceProperty
            const argsSourceProp = node.argumentsSourceProperty; 
            let argsSourceValue = null;
            try {
                argsSourceValue = RED.util.getMessageProperty(currentMsg, argsSourceProp);
            } catch (err) {
                node.warn(`Could not read arguments source property 'msg.${argsSourceProp}': ${err.message}`);
            }

            if (typeof argsSourceValue === 'string') {
                // Split string by spaces
                commandArgsToRun = argsSourceValue.split(" ").filter(a => a !== "");
                node.log(`Using arguments from msg.${argsSourceProp} (string split): ${JSON.stringify(commandArgsToRun)}`);
            } else if (Array.isArray(argsSourceValue)) {
                // Use array elements as args
                commandArgsToRun = argsSourceValue.map(String); // Ensure all elements are strings
                node.log(`Using arguments from msg.${argsSourceProp} (array): ${JSON.stringify(commandArgsToRun)}`);
            } else if (argsSourceValue !== null && typeof argsSourceValue !== 'undefined') {
                // Convert other types to string and use as single argument
                commandArgsToRun = [String(argsSourceValue)];
                node.log(`Using arguments from msg.${argsSourceProp} (converted to string): ${JSON.stringify(commandArgsToRun)}`);
            } else {
                // Fallback to static commandArgs if source is null/undefined
                commandArgsToRun = (node.commandArgs || "").split(" ").filter(a => a !== "");
                node.log(`Using static arguments: ${JSON.stringify(commandArgsToRun)}`);
            }
            
            if (!commandToRun) {
                 node.error("No command specified in node configuration.", originalMsg);
                 node.status({fill:"red",shape:"dot",text:"no command"}); if (done) { done(new Error("No command specified.")); } return;
            }

            // --- 3. Spawn Process --- (Error handling simplified)
            node.status({fill:"blue",shape:"dot",text:"running..."});
            let commandLog = commandToRun + (commandArgsToRun.length > 0 ? " " + commandArgsToRun.join(" ") : "");
            node.log(`Running: ${commandLog} in ${commandOptions.cwd || process.cwd()}`);

            try {
                const child = spawn(commandToRun, commandArgsToRun, commandOptions);
                const pid = child.pid;
                node.activeProcesses[pid] = child;

                let stdoutBuffer = []; // Buffer for complete stdout
                let stderrBuffer = []; // Buffer for complete stderr
                let stdoutClosed = false;
                let stderrClosed = false;
                let processClosed = false;
                let exitCode = null;
                let spawnError = null;

                // Conditionally send control message: started
                if (node.sendStartControl) {
                    const startMsg = RED.util.cloneMessage(originalMsg);
                    const startPayload = { state: 'start', pid: pid };
                    RED.util.setMessageProperty(startMsg, node.resultSource, startPayload);
                    send([null, null, startMsg]); // Send to 3rd output
                }

                 if (node.payloadIs === 'pipe' && currentMsg.payload !== null && typeof currentMsg.payload !== 'undefined') {
                     try {
                         if (Buffer.isBuffer(currentMsg.payload)) {
                             child.stdin.write(currentMsg.payload);
                         } else {
                             child.stdin.write(currentMsg.payload.toString());
                         }
                     } catch(e) { node.error(`Stdin write error: ${e.message}`, originalMsg); }
                     finally { child.stdin.end(); }
                 } else {
                    child.stdin.end();
                 }

                 // --- Handle stdout streaming AND buffering ---
                 child.stdout.on('data', async (data) => {
                    stdoutBuffer.push(data); // Buffer chunk for final control message

                    // --- Stream chunk --- 
                    let stdoutChunk = data.toString('utf8'); // Always use utf8
                    let chunkMsg = RED.util.cloneMessage(originalMsg); // Base each chunk on original msg
                    RED.util.setMessageProperty(chunkMsg, node.resultSource, stdoutChunk);
                    chunkMsg.pid = pid; // Add pid for context

                    // REMOVED postProcessScript execution on stdout chunks
                    // No script execution here, just send the raw chunk
                    send([chunkMsg, null, null]);
                    
                    // --- End stream chunk ---
                });
                child.stdout.on('close', () => {
                    stdoutClosed = true;
                    checkProcessFinished();
                });

                 // --- Handle stderr buffering --- 
                child.stderr.on('data', (data) => {
                    stderrBuffer.push(data);
                });
                child.stderr.on('close', () => {
                    stderrClosed = true;
                    checkProcessFinished();
                });

                child.on('close', (code) => {
                    processClosed = true; exitCode = code; delete node.activeProcesses[pid];
                    node.log(`Command (PID: ${pid}) exited with code: ${code}`);
                    checkProcessFinished();
                });

                child.on('error', (err) => {
                    spawnError = err; processClosed = true; delete node.activeProcesses[pid];
                    node.error(`Spawn error (PID: ${pid}): ${err.toString()}`, originalMsg);
                    checkProcessFinished();
                });

                // Function to handle sending final results (stderr, control)
                async function checkProcessFinished() {
                    if (!processClosed || !stdoutClosed || !stderrClosed) return;

                    // --- Process final results --- 
                    let stdoutResult = Buffer.concat(stdoutBuffer).toString('utf8'); // Always use utf8
                    let stderrResult = Buffer.concat(stderrBuffer).toString('utf8'); // Always use utf8

                    node.status({ fill: "grey", shape: "dot", text: "postprocessing..." });

                    // Create stderr message (if stderr occurred)
                    let stderrMsg = null;
                    if (stderrBuffer.length > 0) {
                        stderrMsg = RED.util.cloneMessage(originalMsg);
                        RED.util.setMessageProperty(stderrMsg, node.resultSource, stderrResult);
                        stderrMsg.pid = pid;
                    }

                    // Create final control message, including complete stdout/stderr
                    let controlMsg = RED.util.cloneMessage(originalMsg);
                    controlMsg.pid = pid;
                    let controlPayload = {
                        state: spawnError ? 'error' : 'end',
                        rc: spawnError ? null : exitCode,
                        pid: pid,
                        command: commandLog, // Add the executed command string here
                        stdout: stdoutResult, // Add complete stdout
                        stderr: stderrResult  // Add complete stderr
                    };
                    if (spawnError) {
                        controlPayload.error = spawnError.message;
                    }
                    RED.util.setMessageProperty(controlMsg, node.resultSource, controlPayload);


                    // Initialize final messages array
                    let finalOutputMessages = [[], [], []]; // [stdout(streamed), stderr, control]

                    // Prepare potentially final messages (before script)
                    let finalStderrMsg = stderrMsg; // Start with initially generated msg
                    let finalControlMsg = controlMsg; // Start with initially generated msg
                    let scriptErrorOccurred = false;

                    // --- Execute Post-processing Script ONCE on completion (if no spawn error) ---
                    if (node.postProcessScript && !spawnError) {
                        node.log(`Running post-processing script for PID ${pid}`);
                        try {
                            // Prepare the context for the single script execution
                            // Pass only the final control message as 'msg' and the originalMsg
                            const postProcessContext = {
                                msg: finalControlMsg, // The control message object to be modified
                                originalMsg: originalMsg,
                                resultSource: node.resultSource // Pass the result property name
                                // rc, pid, stdout, stderr etc. are available via msg[node.resultSource]
                            };
                            
                            // Create the context for vm
                            const context = vm.createContext({ ...sandboxContext, ...postProcessContext });

                            // Execute the script synchronously within the context
                            // Script modifies context.msg (finalControlMsg) directly
                            vm.runInContext(node.postProcessScript, context, { timeout: 1000 });

                            // Retrieve the potentially modified control message from the context
                            finalControlMsg = context.msg; 
                            // Validate it's still an object (or null if script intends to delete it)
                            if (!(typeof finalControlMsg === 'object' || finalControlMsg === null)) {
                                node.warn("Post-processing script modified control message to a non-object/non-null type. Reverting to original.", originalMsg);
                                finalControlMsg = controlMsg; // Revert to original if invalid
                                // Alternatively, set scriptErrorOccurred = true? Let's revert for now.
                            }

                        } catch (err) {
                             node.error(`Post-processing script error: ${err.toString()}. Aborting final message send.`, originalMsg);
                             scriptErrorOccurred = true; // Flag error to prevent sending final messages
                        }
                    }
                    
                    // Populate the final output array IF script didn't error
                    if (!scriptErrorOccurred) {
                        // Handles single message or null
                        if (finalStderrMsg) {
                             finalOutputMessages[1].push(finalStderrMsg);
                        }
                        if (finalControlMsg) {
                            finalOutputMessages[2].push(finalControlMsg);
                        }
                    }

                    // --- 5. Send Final Results --- (Stdout port is null as it was streamed)
                    send(finalOutputMessages);

                    // --- 6. Update Final Status ---
                    if (spawnError) { node.status({fill:"red",shape:"dot",text:"spawn error"}); }
                    else if (exitCode === 0) { node.status({fill:"green",shape:"dot",text:`done (0)`}); }
                    else if (node.minWarning !== null && exitCode >= node.minWarning && exitCode < node.minError) { node.status({fill:"yellow",shape:"dot",text:`warning (${exitCode})`}); }
                    else if (exitCode >= node.minError) { node.status({fill:"red",shape:"dot",text:`error (${exitCode})`}); }
                    else { node.status({fill:"green",shape:"dot",text:`done (${exitCode})`}); }

                    if (done) { done(); }
                } // end checkProcessFinished

            } catch (err) { // Catch errors during setup/spawn call itself
                 node.error(`Error setting up/spawning command: ${err.toString()}`, originalMsg);
                 node.status({fill:"red",shape:"dot",text:"setup error"});
                 const errorMsg = RED.util.cloneMessage(originalMsg);
                 // Include stdout/stderr buffers in error message if available?
                 let stdoutErr = Buffer.concat(stdoutBuffer).toString('utf8'); // Use utf8
                 let stderrErr = Buffer.concat(stderrBuffer).toString('utf8'); // Use utf8
                 const errorPayload = { state: 'error', error: err.message, stdout: stdoutErr, stderr: stderrErr };
                 RED.util.setMessageProperty(errorMsg, node.resultSource, errorPayload);
                 send([null, null, errorMsg]); if (done) { done(err); }
            }
        });

        node.on('close', function(removed, done) {
            node.status({});
            for (const pid in node.activeProcesses) {
                if (Object.hasOwnProperty.call(node.activeProcesses, pid)) {
                    const child = node.activeProcesses[pid];
                    node.log(`Closing: Killing process PID: ${pid}`);
                    try {
                        process.kill(parseInt(pid), 'SIGTERM'); // Use parseInt just in case
                         setTimeout(() => {
                            try { process.kill(parseInt(pid), 'SIGKILL'); } catch (e) { /* Ignore */ }
                         }, 2000);
                    } catch (e) {
                         try { process.kill(parseInt(pid), 'SIGKILL'); } catch (e2) { /* Ignore */ }
                    }
                }
            }
            node.activeProcesses = {};
            done();
        });
    }

    RED.nodes.registerType("servicely-exec", ServicelyExecNode);
} 