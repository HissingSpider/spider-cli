# API (Powered by Anthropic) Documenation

This API provides you access to Anthropic's Claude API endpoints through SpiderAI servers. This API may only be used for educational purposes. No commercial use is allowed.

Currently, only one endpoint is available through this API and that is the messages (create) endpoint. To use this endpoint set up your client as follows:

~~~
from anthropic import Anthropic

client = Anthropic(
    api_key = <YOUR_API_KEY_FROM_MY_ACCOUNT_PAGE>,
    base_url = https://spideraiapi.richmond.edu/v1
)
~~~

You can then use the client.messages.create() function as follows:

~~~
response = client.messages.create(
  model="claude-3-5-sonnet-20241022",
  max_tokens=1024,
  messages=[
    {"role": "user", "content": "What is the capital of the USA"}
  ]
)
~~~

The allowable arguments include:

messages
model
max_tokens
system
tools
tool_choice
temperature
top_p
top_k
stop_sequences
metadata
thinking
budget_tokens
betas

For more information about this endpoint go to: [Anthropic Claude API Documentation](https://docs.anthropic.com/en/api/messages)

Note: We are working on making other endpoints available to upload files, create vector stores, embeddings, etc.
