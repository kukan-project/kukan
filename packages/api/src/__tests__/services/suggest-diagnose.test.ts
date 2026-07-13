import { describe, it, expect } from 'vitest'
import { classifyCompletionError } from '../../services/suggest/diagnose'

describe('classifyCompletionError', () => {
  it('classifies the three Bedrock setup errors', () => {
    expect(
      classifyCompletionError(
        'bedrock',
        'User: arn:...:role/Task is not authorized to perform: bedrock:InvokeModel on resource: ...'
      )
    ).toBe('bedrock-iam')
    expect(
      classifyCompletionError(
        'bedrock',
        'Model use case details have not been submitted for this account. Fill out the Anthropic use case details form.'
      )
    ).toBe('bedrock-use-case')
    expect(
      classifyCompletionError(
        'bedrock',
        'Model access is denied due to required AWS Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe).'
      )
    ).toBe('bedrock-marketplace')
  })

  it('classifies Ollama and OpenAI errors', () => {
    expect(classifyCompletionError('ollama', 'connect ECONNREFUSED 127.0.0.1:11434')).toBe(
      'ollama-unreachable'
    )
    expect(
      classifyCompletionError('ollama', 'model "gemma4" not found, try pulling it first')
    ).toBe('ollama-model-missing')
    expect(classifyCompletionError('openai', 'Incorrect API key provided (401)')).toBe(
      'openai-auth'
    )
    expect(classifyCompletionError('openai', 'The model `gpt-foo` does not exist')).toBe(
      'openai-model-missing'
    )
  })

  it('returns null for unknown errors and cross-provider mismatches', () => {
    expect(classifyCompletionError('bedrock', 'some transient network blip')).toBeNull()
    // A Bedrock message under the ollama provider must not match a bedrock code
    expect(classifyCompletionError('ollama', 'use case details have not been submitted')).toBeNull()
    expect(classifyCompletionError(null, 'anything')).toBeNull()
  })
})
