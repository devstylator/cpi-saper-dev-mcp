import com.sap.gateway.ip.core.customdev.util.Message
import groovy.json.JsonOutput
import groovy.json.JsonSlurper

def Message processData(Message message) {
    // Header: which Groovy runtime executed this step (script step v1.1 is documented as Groovy 2.4)
    message.setHeader('X-Groovy-Version', GroovySystem.getVersion())

    // Exchange property: visible to the following steps, not sent to the receiver
    message.setProperty('ClaudeProcessed', 'true')

    // Body: {"ip": "..."} -> {"ip": "...", "modified": true}
    // Stream the body into JsonSlurper (design guideline: no parsing of the body as a String)
    def json = new JsonSlurper().parse(message.getBody(Reader))
    json.modified = true
    message.setBody(JsonOutput.toJson(json))

    return message
}
