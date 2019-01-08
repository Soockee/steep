package agent

import helper.JsonUtils
import helper.UniqueID
import io.vertx.core.Vertx
import io.vertx.core.eventbus.ReplyException
import io.vertx.core.impl.NoStackTraceThrowable
import io.vertx.core.json.JsonObject
import io.vertx.junit5.VertxTestContext
import io.vertx.kotlin.core.json.get
import io.vertx.kotlin.core.json.json
import io.vertx.kotlin.core.json.obj
import io.vertx.kotlin.coroutines.dispatcher
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.launch
import model.processchain.ProcessChain
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.rmi.RemoteException

/**
 * Tests for [RemoteAgent]
 * @author Michel Kraemer
 */
class RemoteAgentTest : AgentTest() {
  companion object {
    const val NODE_ID = "RemoteAgentTest"
    const val ADDRESS = RemoteAgentRegistry.AGENT_ADDRESS_PREFIX + NODE_ID
  }

  override fun createAgent(vertx: Vertx): Agent =
      RemoteAgent(ADDRESS, vertx)

  @Test
  override fun execute(vertx: Vertx, ctx: VertxTestContext) {
    vertx.eventBus().consumer<JsonObject>(ADDRESS) { msg ->
      val jsonObj: JsonObject = msg.body()
      val replyAddress: String = jsonObj["replyAddress"]
      val processChain = JsonUtils.fromJson<ProcessChain>(jsonObj["processChain"])

      GlobalScope.launch(vertx.dispatcher()) {
        val la = LocalAgent()
        val results = la.execute(processChain)
        vertx.eventBus().send(replyAddress, json {
          obj(
              "results" to JsonUtils.toJson(results)
          )
        })
      }

      msg.reply("ACK")
    }

    super.execute(vertx, ctx)
  }

  /**
   * Test what happens if a remote agent does not accept the process chain
   */
  @Test
  fun doNotAck(vertx: Vertx, ctx: VertxTestContext) {
    vertx.eventBus().consumer<JsonObject>(ADDRESS) { msg ->
      msg.fail(400, "Unacknowledgeable")
    }

    val agent = createAgent(vertx)
    GlobalScope.launch(vertx.dispatcher()) {
      try {
        agent.execute(ProcessChain())
        ctx.failNow(NoStackTraceThrowable("Agent should throw"))
      } catch (e: ReplyException) {
        ctx.completeNow()
      } catch (t: Throwable) {
        ctx.failNow(t)
      }
    }
  }

  /**
   * Test what happens if a remote agent leaves the cluster
   */
  @Test
  fun abortOnLeave(vertx: Vertx, ctx: VertxTestContext) {
    vertx.eventBus().consumer<JsonObject>(ADDRESS) { msg ->
      // accept the process chain ...
      msg.reply("ACK")

      // but then leave the cluster
      vertx.eventBus().publish(AddressConstants.CLUSTER_NODE_LEFT, NODE_ID)
    }

    val agent = createAgent(vertx)
    GlobalScope.launch(vertx.dispatcher()) {
      try {
        agent.execute(ProcessChain())
        ctx.failNow(NoStackTraceThrowable("Agent should throw"))
      } catch (e: ClosedReceiveChannelException) {
        ctx.completeNow()
      } catch (t: Throwable) {
        ctx.failNow(t)
      }
    }
  }

  /**
   * Test what happens if the remote agent returns an error message
   */
  @Test
  fun errorMessage(vertx: Vertx, ctx: VertxTestContext) {
    val ERROR_MESSAGE = UniqueID.next()

    vertx.eventBus().consumer<JsonObject>(ADDRESS) { msg ->
      // accept the process chain ...
      msg.reply("ACK")

      // but then send an error message
      val jsonObj: JsonObject = msg.body()
      val replyAddress: String = jsonObj["replyAddress"]
      vertx.eventBus().send(replyAddress, json {
        obj(
            "errorMessage" to ERROR_MESSAGE
        )
      })
    }

    val agent = createAgent(vertx)
    GlobalScope.launch(vertx.dispatcher()) {
      try {
        agent.execute(ProcessChain())
        ctx.failNow(NoStackTraceThrowable("Agent should throw"))
      } catch (e: RemoteException) {
        ctx.verify {
          assertThat(e).hasMessage(ERROR_MESSAGE)
        }
        ctx.completeNow()
      } catch (t: Throwable) {
        ctx.failNow(t)
      }
    }
  }
}