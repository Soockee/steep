package agent

import AddressConstants.LOCAL_AGENT_ADDRESS_PREFIX
import ConfigConstants
import com.google.common.cache.CacheBuilder
import db.PluginRegistryFactory
import helper.FileSystemUtils.readRecursive
import helper.UniqueID
import io.vertx.core.Vertx
import io.vertx.core.json.JsonObject
import io.vertx.kotlin.core.eventbus.unregisterAwait
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.suspendCancellableCoroutine
import model.metadata.Service
import model.plugins.call
import model.processchain.Argument
import model.processchain.ArgumentVariable
import model.processchain.Executable
import model.processchain.ProcessChain
import runtime.DockerRuntime
import runtime.OtherRuntime
import java.io.File
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.reflect.full.callSuspend

/**
 * An agent that executes process chains locally
 * @param vertx the Vert.x instance
 * @dispatcher a coroutine dispatcher used to execute blocking process chains
 * in an asynchronous manner. Should be a [java.util.concurrent.ThreadPoolExecutor]
 * converted to a [CoroutineDispatcher] through [kotlinx.coroutines.asCoroutineDispatcher].
 * @author Michel Kraemer
 */
class LocalAgent(private val vertx: Vertx, val dispatcher: CoroutineDispatcher) : Agent, CoroutineScope {
  companion object {
    /**
     * A cache that tracks which directories we already created
     */
    private val mkdirCache = CacheBuilder.newBuilder()
        .expireAfterAccess(1, TimeUnit.MINUTES)
        .maximumSize(1000)
        .build<String, Boolean>()
  }

  override val id: String = UniqueID.next()

  override val coroutineContext: CoroutineContext by lazy { dispatcher + Job() }

  private val config = vertx.orCreateContext.config()

  private val pluginRegistry = PluginRegistryFactory.create()
  private val outputLinesToCollect = config
      .getInteger(ConfigConstants.AGENT_OUTPUT_LINES_TO_COLLECT, 100)

  private val otherRuntime by lazy { OtherRuntime() }
  private val dockerRuntime by lazy { DockerRuntime(config) }

  override suspend fun execute(processChain: ProcessChain): Map<String, List<Any>> {
    val outputs = processChain.executables
        .flatMap { it.arguments }
        .filter { it.type == Argument.Type.OUTPUT }
    val executables = mkdirsForOutputs(outputs) + processChain.executables

    // temporarily register a consumer that can cancel the process chain
    val address = LOCAL_AGENT_ADDRESS_PREFIX + processChain.id
    val consumer = vertx.eventBus().consumer<JsonObject>(address).handler { msg ->
      if (msg.body().getString("action") == "cancel") {
        cancel()
      }
    }

    // execute the process chain
    try {
      for (exec in executables) {
        execute(exec)
      }
    } finally {
      // make sure the consumer is unregistered
      consumer.unregisterAwait()
    }

    // create list of results
    val fs = vertx.fileSystem()
    return outputs.associate {
      val outputAdapter = pluginRegistry.findOutputAdapter(it.dataType)
      it.variable.id to (outputAdapter?.call(it, processChain, vertx) ?:
          readRecursive(it.variable.value, fs))
    }
  }

  /**
   * Try to cancel the process chain execution. Interrupt the thread that
   * executes the process chain.
   */
  fun cancel() {
    coroutineContext.cancel()
  }

  private suspend fun execute(exec: Executable) {
    if (exec.runtime == Service.RUNTIME_DOCKER) {
      interruptableAsync {
        dockerRuntime.execute(exec, outputLinesToCollect)
      }.await()
    } else if (exec.runtime == Service.RUNTIME_OTHER) {
      interruptableAsync {
        otherRuntime.execute(exec, outputLinesToCollect)
      }.await()
    } else {
      val r = pluginRegistry.findRuntime(exec.runtime) ?:
          throw IllegalStateException("Unknown runtime: `${exec.runtime}'")
      if (r.compiledFunction.isSuspend) {
        r.compiledFunction.callSuspend(exec, outputLinesToCollect, vertx)
      } else {
        interruptableAsync {
          r.compiledFunction.call(exec, outputLinesToCollect, vertx)
        }.await()
      }
    }
  }

  /**
   * Executes the given [block] in the [coroutineContext]. Handles cancellation
   * requests and interrupts the thread that executes the [block].
   */
  private fun interruptableAsync(block: () -> String): Deferred<String> = async {
    suspendCancellableCoroutine<String> { cont ->
      val t = Thread.currentThread()

      cont.invokeOnCancellation {
        t.interrupt()
      }

      try {
        cont.resume(block())
      } catch (ie: InterruptedException) {
        cont.resumeWithException(CancellationException(ie.message ?:
            "Process chain execution was interrupted"))
      } catch (t: Throwable) {
        cont.resumeWithException(t)
      }
    }
  }

  /**
   * Create `mkdir` commands for all output directories
   * @param outputs the outputs
   * @return the `mkdir` commands
   */
  private fun mkdirsForOutputs(outputs: List<Argument>): List<Executable> {
    val so = outputs.map {
      if (it.dataType == Argument.DATA_TYPE_DIRECTORY) {
        it.variable.value
      } else {
        File(it.variable.value).parent
      }
    }.filter { path ->
      if (mkdirCache.getIfPresent(path) == null) {
        mkdirCache.put(path, true)
        true
      } else {
        false
      }
    }

    return so.chunked(100).map { w ->
      Executable(
        path = "mkdir",
        arguments = listOf(
            Argument(
                label = "-p",
                variable = ArgumentVariable(UniqueID.next(), "true"),
                type = Argument.Type.ARGUMENT,
                dataType = Argument.DATA_TYPE_BOOLEAN
            )
        ) + w.map { o ->
          Argument(
              variable = ArgumentVariable(UniqueID.next(), o),
              type = Argument.Type.ARGUMENT
          )
        }
      )
    }
  }
}
