// OpenRouter provider: OpenAI-compatible + recommended routing headers.
const { completeJSON } = require('./chat');

function complete(args) {
  return completeJSON({
    ...args,
    extraHeaders: {
      'HTTP-Referer': 'https://localhost:3000/',
      'X-Title': 'Orator',
    },
  });
}

module.exports = { complete };
