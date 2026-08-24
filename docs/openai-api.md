# API (Powered by OpenAI) Documenation

This API provides you access to the OpenAI's API endpoints through SpiderAI servers. This API may only be used for educational purposes. No commercial use is allowed.

Currently, only one end point is available through this API and that is the responses (create) endpoint. To use this end point set up your client as follows:

~~~
from openai import OpenAI

client = OpenAI(
    api_key = <YOUR_API_KEY_FROM_MY_ACCOUNT_PAGE>,
    base_url = https://spideraiapi.richmond.edu/v1
)
~~~

You can then use the client.responses.create() function as follows:

~~~
response = client.responses.create(
  model="gpt-4.1",
  input="What is the capital of the USA"
)
~~~

The allowable argument include:
- background
- include
- input
- instructions
- max_output_tokens
- max_tool_calls
- metadata
- model
- parallel_tool_calls
- previous_response_id
- prompt
- prompt_cache_key
- reasoning
- store
- stream
- stream_options
- temperature
- text
- tools
- top_logprobs
- top_p
- truncation
- verbosity

For more information about this endpoint go to: [OpenAI API Documentation](https://platform.openai.com/docs/api-reference/responses/create?lang=python)

Note: We are working on making other endpoints available to upload files, create vector stores, embeddings, etc.
