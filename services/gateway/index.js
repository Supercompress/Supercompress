"use strict";

const { createPipeline, stubStages, STAGE_ORDER } = require("./pipeline");
const { fromChatCompletions, toChatCompletions } = require("./adapters/chat-completions");
const { createWiredGateway } = require("./wire");
const { createCompressFn, createDefaultCompressFn } = require("./compress");
const {
  createProvider,
  createOpenAIProvider,
  createAnthropicProvider,
  callStubProvider,
} = require("./providers");
const { flags } = require("../../packages/control-plane");
const http = require("./http");

/**
 * Unadvertised gateway entry. Enable with SC_CP_GATEWAY=1 at the process edge.
 */
function isGatewayEnabled() {
  return flags().gateway;
}

module.exports = {
  STAGE_ORDER,
  createPipeline,
  stubStages,
  fromChatCompletions,
  toChatCompletions,
  createWiredGateway,
  createCompressFn,
  createDefaultCompressFn,
  createProvider,
  createOpenAIProvider,
  createAnthropicProvider,
  callStubProvider,
  isGatewayEnabled,
  writeOpenAiSse: http.writeOpenAiSse,
  getProcessGateway: http.getProcessGateway,
};
