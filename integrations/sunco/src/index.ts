import { RuntimeError } from '@botpress/client'
import { sentry as sentryHelpers } from '@botpress/sdk-addons'
import * as bp from '.botpress'
const SunshineConversationsClient = require('sunshine-conversations-client')

type SmoochBaseAction = {
  type: string
  text: string
}

type SmoochLinkAction = {
  type: 'link'
  uri: string
} & SmoochBaseAction

type SmoochPostbackAction = {
  type: 'postback'
  payload: string
} & SmoochBaseAction

type SmoochReplyAction = {
  type: 'reply'
  payload: string
} & SmoochBaseAction

type SmoochAction = SmoochLinkAction | SmoochPostbackAction | SmoochReplyAction

type SmoochCard = {
  title: string
  description?: string
  mediaUrl?: string
  actions: SmoochAction[]
}

const POSTBACK_PREFIX = 'postback::'
const SAY_PREFIX = 'say::'

const integration = new bp.Integration({
  register: async () => {},
  unregister: async () => {},
  actions: {
    startTypingIndicator: async ({ client, ctx, input }) => {
      const { conversationId } = input
      await sendActivity({
        client,
        ctx,
        conversationId,
        typingStatus: 'start',
        markAsRead: true,
      })
      return {}
    },
    stopTypingIndicator: async ({ client, ctx, input }) => {
      const { conversationId } = input
      await sendActivity({
        client,
        ctx,
        conversationId,
        typingStatus: 'stop',
      })
      return {}
    },
    getOrCreateUser: async ({ client, input, ctx }) => {
      const suncoClient = createClient(ctx.configuration.keyId, ctx.configuration.keySecret)
      const suncoUser = await suncoClient.users.getUser(ctx.configuration.appId, input.user.id)
      const suncoProfile = suncoUser.user?.profile

      const name = input.name ?? [suncoProfile?.givenName, suncoProfile?.surname].join(' ').trim()
      const { user } = await client.getOrCreateUser({
        tags: { id: `${suncoUser.user?.id}` },
        name,
        pictureUrl: input.pictureUrl ?? suncoProfile?.avatarUrl,
      })

      return {
        userId: user.id,
      }
    },
    getOrCreateConversation: async ({ client, input, ctx }) => {
      const suncoClient = createClient(ctx.configuration.keyId, ctx.configuration.keySecret)
      const suncoConversation = await suncoClient.conversations.getConversation(
        ctx.configuration.appId,
        input.conversation.id
      )

      const { conversation } = await client.getOrCreateConversation({
        channel: 'channel',
        tags: { id: `${suncoConversation.conversation?.id}` },
      })

      return {
        conversationId: conversation.id,
      }
    },
  },
  channels: {
    channel: {
      messages: {
        text: async (props) => {
          await sendMessage(props, { type: 'text', text: props.payload.text })
        },
        image: async (props) => {
          await sendMessage(props, { type: 'image', mediaUrl: props.payload.imageUrl })
        },
        markdown: async (props) => {
          await sendMessage(props, { type: 'text', text: props.payload.markdown })
        },
        audio: async (props) => {
          await sendMessage(props, { type: 'file', mediaUrl: props.payload.audioUrl })
        },
        video: async (props) => {
          await sendMessage(props, { type: 'file', mediaUrl: props.payload.videoUrl })
        },
        file: async (props) => {
          try {
            await sendMessage(props, { type: 'file', mediaUrl: props.payload.fileUrl })
          } catch (e) {
            const err = e as any
            // 400 errors can be sent if file has unsupported type
            // See: https://docs.smooch.io/guide/validating-files/#rejections
            if (err.status === 400 && err.response?.text) {
              console.info(err.response.text)
            }
            throw e
          }
        },
        location: async (props) => {
          await sendMessage(props, {
            type: 'location',
            coordinates: {
              lat: props.payload.latitude,
              long: props.payload.longitude,
            },
          })
        },
        carousel: async (props) => {
          await sendCarousel(props, props.payload)
        },
        card: async (props) => {
          await sendCarousel(props, { items: [props.payload] })
        },
        dropdown: async (props) => {
          await sendMessage(props, renderChoiceMessage(props.payload))
        },
        choice: async (props) => {
          await sendMessage(props, renderChoiceMessage(props.payload))
        },
        bloc: () => {
          throw new RuntimeError('Not implemented')
        },
      },
    },
  },


  handler: async ({ req, client }) => {
    if (!req.body) {
      console.warn('Handler received an empty body')
      return
    }

    const data = JSON.parse(req.body)

    for (const event of data.events) {
      if (event.type !== 'conversation:message') {
        console.warn('Received an event that is not a message')
        continue
      }

      const payload = event.payload

      // Removido o filtro que só aceitava mensagens de texto
      // Agora aceita diferentes tipos de conteúdo
      const messageContent = payload.message.content

      if (payload.message.author.type === 'business') {
        console.warn('Skipping message that is from a business')
        continue
      }

      const { conversation } = await client.getOrCreateConversation({
        channel: 'channel',
        tags: {
          id: payload.conversation.id,
        },
      })

      const { user } = await client.getOrCreateUser({
        tags: {
          id: payload.message.author.userId,
        },
        name: payload.message.author.displayName,
        pictureUrl: payload.message.author.avatarUrl,
      })

      // Criar mensagem baseada no tipo de conteúdo
      let messagePayload: any
      let messageType: string

      switch (messageContent.type) {
        case 'text':
          messageType = 'text'
          messagePayload = { text: messageContent.text }
          break
        
        case 'file':
          // Verificar se é áudio baseado no mediaType
          if (messageContent.mediaType?.startsWith('audio/')) {
            messageType = 'audio'
            messagePayload = { audioUrl: messageContent.mediaUrl }
          } else if (messageContent.mediaType?.startsWith('video/')) {
            messageType = 'video'
            messagePayload = { videoUrl: messageContent.mediaUrl }
          } else if (messageContent.mediaType?.startsWith('image/')) {
            messageType = 'image'
            messagePayload = { imageUrl: messageContent.mediaUrl }
          } else {
            // Para outros tipos de arquivo
            messageType = 'file'
            messagePayload = { fileUrl: messageContent.mediaUrl }
          }
          break
        
        case 'image':
          messageType = 'image'
          messagePayload = { imageUrl: messageContent.mediaUrl }
          break
        
        case 'location':
          messageType = 'location'
          messagePayload = {
            latitude: messageContent.coordinates?.lat,
            longitude: messageContent.coordinates?.long
          }
          break
        
        default:
          console.warn(`Unsupported message type: ${messageContent.type}`)
          continue
      }

      await client.createMessage({
        tags: { id: payload.message.id },
        type: messageType,
        userId: user.id,
        conversationId: conversation.id,
        payload: messagePayload,
      })
    }
  },
})

export default sentryHelpers.wrapIntegration(integration, {
  dsn: bp.secrets.SENTRY_DSN,
  environment: bp.secrets.SENTRY_ENVIRONMENT,
  release: bp.secrets.SENTRY_RELEASE,
})

type Choice = bp.channels.channel.choice.Choice

function renderChoiceMessage(payload: Choice) {
  return {
    type: 'text',
    text: payload.text,
    actions: payload.options.map((r) => ({ type: 'reply', text: r.label, payload: r.value })),
  }
}

type Carousel = bp.channels.channel.carousel.Carousel

const sendCarousel = async (props: SendMessageProps, payload: Carousel) => {
  const items: SmoochCard[] = []

  for (const card of payload.items) {
    const actions: SmoochAction[] = []
    for (const button of card.actions) {
      if (button.action === 'url') {
        actions.push({
          type: 'link',
          text: button.label,
          uri: button.value,
        })
      } else if (button.action === 'postback') {
        actions.push({
          type: 'postback',
          text: button.label,
          payload: `${POSTBACK_PREFIX}${button.value}`,
        })
      } else if (button.action === 'say') {
        actions.push({
          type: 'postback',
          text: button.label,
          payload: `${SAY_PREFIX}${button.label}`,
        })
      }
    }

    if (actions.length === 0) {
      actions.push({
        type: 'postback',
        text: card.title,
        payload: card.title,
      })
    }

    items.push({ title: card.title, description: card.subtitle, mediaUrl: card.imageUrl, actions })
  }

  await sendMessage(props, {
    type: 'carousel',
    items,
  })
}

function getConversationId(conversation: SendMessageProps['conversation']) {
  const conversationId = conversation.tags.id

  if (!conversationId) {
    throw new Error('Conversation does not have a sunco identifier')
  }

  return conversationId
}

function createClient(keyId: string, keySecret: string) {
  const client = new SunshineConversationsClient.ApiClient()
  const auth = client.authentications['basicAuth']
  auth.username = keyId
  auth.password = keySecret

  return {
    messages: new SunshineConversationsClient.MessagesApi(client),
    activity: new SunshineConversationsClient.ActivitiesApi(client),
    apps: new SunshineConversationsClient.AppsApi(client),
    conversations: new SunshineConversationsClient.ConversationsApi(client),
    users: new SunshineConversationsClient.UsersApi(client),
  }
}

type SendMessageProps = Pick<bp.AnyMessageProps, 'ctx' | 'conversation' | 'ack'>

async function sendMessage({ conversation, ctx, ack }: SendMessageProps, payload: any) {
  const client = createClient(ctx.configuration.keyId, ctx.configuration.keySecret)

  const data = new SunshineConversationsClient.MessagePost()
  data.content = payload
  data.author = {
    type: 'business',
  }

  const { messages } = await client.messages.postMessage(ctx.configuration.appId, getConversationId(conversation), data)

  const message = messages[0]

  if (!message) {
    throw new Error('Message not sent')
  }

  await ack({ tags: { id: message.id } })

  if (messages.length > 1) {
    console.warn('More than one message was sent')
  }
}

type SendActivityProps = Pick<bp.AnyMessageProps, 'ctx' | 'client'> & {
  conversationId: string
  typingStatus?: 'start' | 'stop'
  markAsRead?: boolean
}
async function sendActivity({ client, ctx, conversationId, typingStatus, markAsRead }: SendActivityProps) {
  const { conversation } = await client.getConversation({ id: conversationId })
  const suncoConversationId = getConversationId(conversation)
  const { appId, keyId, keySecret } = ctx.configuration
  const suncoClient = createClient(keyId, keySecret)
  if (markAsRead) {
    await suncoClient.activity.postActivity(appId, suncoConversationId, {
      type: 'conversation:read',
      author: { type: 'business' },
    })
  }
  if (typingStatus) {
    await suncoClient.activity.postActivity(appId, suncoConversationId, {
      type: `typing:${typingStatus}`,
      author: { type: 'business' },
    })
  }
}
